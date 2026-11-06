import { computed, reactive, ref } from 'vue';
import type {
  LocalServiceConnectionView,
  LocalOwnerScopeGrant,
  LocalServiceOwnerOperationItem,
  LocalServiceOwnerReceipt,
  LocalServiceConnectionSetRequest,
} from '@runnets/contracts';
import { call } from './bridge.js';
import type { ServiceCommand } from '../service-protocol.js';
export const serviceVersions = (c: LocalServiceConnectionView) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
const empty = () => ({
  connectionId: '',
  name: '',
  configuration: {
    kind: 'http' as const,
    url: '',
  } as LocalServiceConnectionSetRequest['configuration'],
  metadataPermission: 'none' as 'none' | 'allow',
});
type Mutation = Extract<
  ServiceCommand,
  {
    op:
      'service-set' | 'service-disconnect' | 'service-refresh' | 'service-grant' | 'service-revoke';
  }
>;
function configuration(c: LocalServiceConnectionSetRequest['configuration']) {
  return c.kind === 'http' ? { ...c } : { ...c, args: [...c.args] };
}
export function createServiceSettings(request: typeof call = call) {
  const connections = ref<readonly LocalServiceConnectionView[]>([]),
    grants = ref<readonly LocalOwnerScopeGrant[]>([]),
    operations = ref<readonly LocalServiceOwnerOperationItem[]>([]);
  const key = ref(''),
    selected = ref(''),
    message = ref(''),
    busy = ref(false),
    stale = ref(true),
    roomId = ref(''),
    botId = ref('');
  const receipt = ref<LocalServiceOwnerReceipt | null>(null),
    pending = ref<{ requestId: string; targetId: string } | null>(null);
  const draft = reactive(empty());
  const current = computed(() => connections.value.find((x) => x.id === selected.value));
  let epoch = 0;
  function invalidate() {
    ++epoch;
    key.value = '';
    message.value = '';
    receipt.value = null;
  }
  function context(room: string, bot: string) {
    invalidate();
    roomId.value = room;
    botId.value = bot;
  }
  function close() {
    invalidate();
    stale.value = true;
  }
  function select(id: string) {
    invalidate();
    selected.value = id;
    const c = current.value;
    Object.assign(
      draft,
      c
        ? {
            connectionId: c.id,
            name: c.name,
            configuration: configuration(c.configuration),
            metadataPermission: c.trust.metadataPermission,
          }
        : { ...empty(), connectionId: id },
    );
  }
  async function load() {
    const token = epoch;
    stale.value = true;
    key.value = '';
    try {
      const [cs, gs] = await Promise.all([
        request({ op: 'service-connections' }),
        request({ op: 'service-grants' }),
      ]);
      const items: LocalServiceOwnerOperationItem[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; ++page) {
        const result = await request({
          op: 'service-operations',
          input: { limit: 50, state: 'prepared', ...(after ? { after } : {}) },
        });
        items.push(...result.items);
        if (result.next === null) {
          after = undefined;
          break;
        }
        if (result.next === after || !result.items.length) throw Error('invalid_frame');
        after = result.next;
      }
      if (token !== epoch) return;
      connections.value = cs;
      const active = current.value;
      if (active)
        Object.assign(draft, {
          connectionId: active.id,
          name: active.name,
          configuration: configuration(active.configuration),
          metadataPermission: active.trust.metadataPermission,
        });
      grants.value = gs;
      operations.value = items;
      stale.value = false;
      if (after)
        message.value =
          'Показаны первые 1000 prepared операций; остальные доступны через runtime client.';
    } catch (e) {
      if (token === epoch)
        message.value = String(e instanceof Error ? e.message : 'outcome_unknown');
    }
  }
  async function lookup(requestId: string, token = epoch) {
    key.value = '';
    try {
      const r = await request({ op: 'service-receipt', input: { requestId } });
      if (r && r.requestId !== requestId) throw Error('invalid_frame');
      if (token !== epoch) return;
      receipt.value = r;
      message.value = r
        ? `Исходная квитанция: ${r.state}. ${r.state === 'completed' ? 'Снимок исходного результата; текущие метаданные показаны отдельно.' : 'Успех не подтверждён; требуется новое явное восстановление.'}`
        : 'Квитанция отсутствует; успех неизвестен. Запрос не повторён.';
    } catch (e) {
      if (token === epoch)
        message.value =
          'Исходная квитанция неизвестна: ' + String(e instanceof Error ? e.message : e);
    }
  }
  async function mutate(command: Mutation) {
    key.value = '';
    if (busy.value || stale.value) return;
    const token = epoch,
      requestId = command.input.requestId;
    const targetId =
      'connectionId' in command.input
        ? command.input.connectionId
        : 'grantId' in command.input
          ? command.input.grantId
          : command.input.intent.id;
    pending.value = { requestId, targetId };
    busy.value = true;
    try {
      const r = await request(command);
      if (r.requestId !== requestId) throw Error('invalid_frame');
      if (token !== epoch) return;
      receipt.value = r;
      message.value = `Исходная квитанция: ${r.state}. Разрешение не доказывает исполнение.`;
    } catch (e) {
      await lookup(requestId, token);
      if (token === epoch)
        message.value =
          String(e instanceof Error ? e.message : 'outcome_unknown') + ' · ' + message.value;
    } finally {
      busy.value = false;
      if (token === epoch) await load();
    }
  }
  async function save(removeKey = false) {
    const secret = key.value;
    key.value = '';
    const input: LocalServiceConnectionSetRequest = {
      connectionId: draft.connectionId,
      name: draft.name,
      configuration: configuration(draft.configuration),
      metadataPermission: draft.metadataPermission,
      requestId: crypto.randomUUID(),
      expectedVersions: current.value ? serviceVersions(current.value) : null,
      ...(draft.configuration.kind === 'http'
        ? removeKey
          ? { removeKey: true }
          : secret
            ? { key: secret }
            : {}
        : {}),
    };
    await mutate({ op: 'service-set', input });
  }
  async function action(op: 'service-disconnect' | 'service-refresh') {
    key.value = '';
    const c = current.value;
    if (!c) return;
    await mutate({
      op,
      input: {
        requestId: crypto.randomUUID(),
        connectionId: c.id,
        expectedVersions: serviceVersions(c),
      },
    });
  }
  async function recover(item: LocalServiceOwnerOperationItem) {
    const secret = key.value;
    key.value = '';
    const op = item.operation;
    if (item.state !== 'prepared' || !op) {
      message.value = 'Старый неизвестный intent доступен только для чтения; настройте вручную.';
      return;
    }
    if (op.requiresKey && !secret) {
      message.value = 'Введите ключ заново для нового явного восстановления.';
      return;
    }
    const c = connections.value.find((x) => x.id === op.input.connectionId);
    const expectedVersions = c ? serviceVersions(c) : null;
    const requestId = crypto.randomUUID();
    if (op.method === 'service.connection-set')
      await mutate({
        op: 'service-set',
        input: {
          ...op.input,
          requestId,
          expectedVersions,
          ...(op.requiresKey ? { key: secret } : {}),
        },
      });
    else if (expectedVersions)
      await mutate({ op: 'service-refresh', input: { ...op.input, requestId, expectedVersions } });
    else message.value = 'Подключение отсутствует; обновление невозможно.';
  }
  return {
    get contextEpoch() {
      return epoch;
    },
    connections,
    grants,
    operations,
    key,
    selected,
    message,
    busy,
    stale,
    roomId,
    botId,
    receipt,
    pending,
    draft,
    current,
    context,
    close,
    select,
    load,
    save,
    action,
    recover,
    lookup,
    mutate,
  };
}
export type ServiceSettings = ReturnType<typeof createServiceSettings>;
