import { computed, reactive, ref } from 'vue';
import type {
  LocalServiceConnectionView,
  LocalOwnerScopeGrant,
  LocalServiceOwnerOperationItem,
  LocalServiceOwnerReceipt,
  LocalServiceConnectionSetRequest,
} from '@runnets/contracts';
import { call } from './bridge.js';
import { createServiceRecovery } from './service-recovery.js';
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
export type ServiceMutation = Extract<
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
  let epoch = 0,
    lookupVersion = 0;
  const lookupRequestId = ref<string | null>(null);
  function invalidate() {
    ++epoch;
    ++lookupVersion;
    lookupRequestId.value = null;
    recovery.clear();
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
    recovery.clear();
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
    if (token !== epoch) return false;
    recovery.clear();
    const version = ++lookupVersion;
    receipt.value = null;
    lookupRequestId.value = requestId;
    message.value = '';
    key.value = '';
    try {
      const r = await request({ op: 'service-receipt', input: { requestId } });
      if (r && r.requestId !== requestId) throw Error('invalid_frame');
      if (token !== epoch || version !== lookupVersion) return false;
      receipt.value = r;
      message.value = r
        ? `Исходная квитанция: ${r.state}. ${r.state === 'completed' ? 'Снимок исходного результата; текущие метаданные показаны отдельно.' : 'Успех не подтверждён; требуется новое явное восстановление.'}`
        : 'Квитанция отсутствует; успех неизвестен. Запрос не повторён.';
      return true;
    } catch (e) {
      if (token === epoch && version === lookupVersion)
        message.value =
          'Исходная квитанция неизвестна: ' + String(e instanceof Error ? e.message : e);
    }
    return false;
  }
  async function mutate(command: ServiceMutation) {
    recovery.clear();
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
    const version = ++lookupVersion;
    receipt.value = null;
    lookupRequestId.value = requestId;
    message.value = '';
    pending.value = { requestId, targetId };
    busy.value = true;
    try {
      const r = await request(command);
      if (r.requestId !== requestId) throw Error('invalid_frame');
      if (token !== epoch || version !== lookupVersion) return;
      receipt.value = r;
      message.value = `Исходная квитанция: ${r.state}. Разрешение не доказывает исполнение.`;
    } catch (e) {
      if (version !== lookupVersion || token !== epoch) return;
      if (await lookup(requestId, token))
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
    const c = current.value;
    if (removeKey) {
      if (c?.configuration.kind !== 'http') return;
      await mutate({
        op: 'service-set',
        input: {
          requestId: crypto.randomUUID(),
          connectionId: c.id,
          name: c.name,
          configuration: configuration(c.configuration),
          metadataPermission: c.trust.metadataPermission,
          expectedVersions: serviceVersions(c),
          removeKey: true,
        },
      });
      return;
    }
    const input: LocalServiceConnectionSetRequest = {
      connectionId: draft.connectionId,
      name: draft.name,
      configuration: configuration(draft.configuration),
      metadataPermission: draft.metadataPermission,
      requestId: crypto.randomUUID(),
      expectedVersions: current.value ? serviceVersions(current.value) : null,
      ...(draft.configuration.kind === 'http' ? (secret ? { key: secret } : {}) : {}),
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
  const recovery = createServiceRecovery({ key, connections, message, mutate });
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
    lookupRequestId,
    recoverySelection: recovery.selected,
    recoveryKey: recovery.key,
    selectRecovery: recovery.select,
    pending,
    draft,
    current,
    context,
    close,
    select,
    load,
    save,
    action,
    recover: recovery.recover,
    lookup,
    mutate,
  };
}
export type ServiceSettings = ReturnType<typeof createServiceSettings>;
