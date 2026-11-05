import { computed, reactive, ref, watch, toRaw } from 'vue';
import type {
  LocalModelConnectionMetadata,
  LocalModelConnectionSetRequest,
  ModelPreset,
} from '../model-protocol.js';
import { call } from './bridge.js';
import { modelPages } from './model-pages.js';
import {
  conflictText,
  settingsError,
  unknownOutcome,
  unknownText,
  connectionCheckLine,
} from './model-settings-text.js';
import {
  recoveryCommand,
  keyless,
  resupply,
  type ConnectionMutation,
  type PendingConnectionMutation,
} from './model-settings-recovery.js';
type Draft = {
  -readonly [
    K in keyof Omit<LocalModelConnectionSetRequest, 'requestId' | 'expectedRevision' | 'key'>
  ]: LocalModelConnectionSetRequest[K];
};
const empty = (): Draft => ({
  connectionId: '',
  providerId: '',
  kind: 'cloud',
  endpoint: '',
  auth: 'api_key',
  defaultModelId: '',
});
export function createConnectionSettings(request: typeof call = call) {
  const connections = ref<LocalModelConnectionMetadata[]>([]),
    presets = ref<ModelPreset[]>([]);
  const selected = ref(''),
    key = ref(''),
    busy = ref(false),
    stale = ref(true),
    message = ref('');
  const pending = ref<PendingConnectionMutation | null>(null);
  const checkResult = ref('');
  const draft = reactive<Draft>(empty());
  const current = computed(() => connections.value.find((x) => x.connectionId === selected.value));
  const writeRestriction = computed(
    () => connections.value.find((x) => x.restriction !== null)?.restriction ?? null,
  );
  const canEdit = computed(
    () =>
      !busy.value &&
      !stale.value &&
      !pending.value &&
      !writeRestriction.value &&
      (current.value?.writable ?? true) &&
      !current.value?.recovery,
  );
  let generation = 0,
    selectionVersion = 0;
  watch(
    () => draft.auth,
    () => {
      key.value = '';
    },
    { flush: 'sync' },
  );
  watch(
    () => draft.kind,
    (kind) => {
      key.value = '';
      if (kind === 'cloud') draft.auth = 'api_key';
    },
    { flush: 'sync' },
  );
  function select(id: string) {
    ++selectionVersion;
    key.value = '';
    selected.value = id;
    checkResult.value = '';
    const entry = current.value;
    Object.assign(
      draft,
      entry
        ? {
            connectionId: entry.connectionId,
            providerId: entry.providerId,
            kind: entry.kind,
            endpoint: entry.endpoint ?? '',
            auth: entry.auth,
            defaultModelId: entry.defaultModelId ?? '',
          }
        : empty(),
    );
  }
  function propose(preset: ModelPreset) {
    if (selected.value) return;
    key.value = '';
    Object.assign(draft, {
      providerId: preset.providerId,
      kind: preset.kind,
      endpoint: preset.endpoint,
      auth: preset.kind === 'local' ? 'none' : 'api_key',
      defaultModelId: '',
    });
  }
  function close() {
    ++generation;
    ++selectionVersion;
    key.value = '';
  }
  async function load() {
    const token = ++generation;
    key.value = '';
    stale.value = true;
    try {
      const loaded = await modelPages(
        async (after) => {
          const page = await request({
            op: 'model-connections',
            input: { workspaceId: 'ws_ocean', ...(after ? { after } : {}) },
          });
          if (page.workspaceId !== 'ws_ocean') throw Error('invalid_frame');
          return page;
        },
        (x) => x.connectionId,
      );
      const suggestions = await request({ op: 'model-presets' });
      if (token !== generation) return;
      connections.value = loaded;
      presets.value = suggestions;
      stale.value = false;
      select(selected.value);
    } catch (error) {
      if (token === generation) message.value = settingsError(error);
    }
  }
  async function mutate(command: ConnectionMutation, id: string) {
    if (busy.value || stale.value) return;
    const original = keyless(command, id);
    busy.value = true;
    message.value = '';
    try {
      const result = await request(command);
      if ('connectionId' in result && result.connectionId !== id) throw Error('outcome_unknown');
      pending.value = null;
      await load();
      if (!stale.value && connections.value.some((x) => x.connectionId === id)) select(id);
      message.value = stale.value
        ? 'Операция подтверждена; метаданные прочитать не удалось. Редактирование заблокировано.'
        : 'Операция подтверждена. Метаданные обновлены. Отключение не отменяет запуски и не отзывает ключ.';
    } catch (error) {
      if (error instanceof Error && error.message === 'revision_conflict') {
        pending.value = null;
        await load();
        message.value = conflictText;
      } else {
        if (
          unknownOutcome(error) ||
          (error instanceof Error && error.message === 'provider_write_failed')
        )
          pending.value = original;
        await load();
        if (pending.value && connections.value.some((x) => x.connectionId === id)) select(id);
        message.value = pending.value ? unknownText : settingsError(error);
      }
    } finally {
      busy.value = false;
    }
  }
  async function save(repair = false) {
    const secret = key.value.trim();
    key.value = '';
    const entry = current.value;
    if (repair && (!secret || draft.auth !== 'api_key')) {
      message.value = 'Для отдельного исправления выберите API key и введите новый ключ.';
      return;
    }
    if (
      repair
        ? !entry?.writable ||
          entry.recovery?.kind !== 'explicit_key_repair_required' ||
          !secret ||
          pending.value
        : !canEdit.value
    )
      return;
    if (busy.value || stale.value) return;
    const input = {
      ...draft,
      requestId: crypto.randomUUID(),
      expectedRevision: entry?.revision ?? null,
      ...(draft.auth === 'api_key' && secret ? { key: secret } : {}),
    };
    if (repair && (input.auth !== 'api_key' || !input.key)) return;
    await mutate({ op: 'model-set', input }, input.connectionId);
  }
  async function revisionAction(op: 'model-disconnect' | 'model-remove-key') {
    key.value = '';
    const entry = current.value;
    if (!canEdit.value || !entry) return;
    await mutate(
      {
        op,
        input: {
          connectionId: entry.connectionId,
          expectedRevision: entry.revision,
          requestId: crypto.randomUUID(),
        },
      },
      entry.connectionId,
    );
  }
  async function recover() {
    const secret = key.value.trim();
    key.value = '';
    if (busy.value || stale.value) return;
    try {
      const entry = current.value;
      if (entry && !entry.writable) return;
      if (entry?.recovery?.kind === 'retry_available') {
        const command = recoveryCommand(entry.recovery.request, secret);
        if (
          command.op !== 'model-set' &&
          command.op !== 'model-remove-key' &&
          command.op !== 'provider-set' &&
          command.op !== 'provider-remove-key'
        )
          throw Error('invalid_request');
        await mutate(command, entry.connectionId);
      } else if (
        pending.value &&
        (!entry?.recovery || entry.recovery.kind === 'original_input_required')
      ) {
        const original = toRaw(pending.value);
        await mutate(resupply(original, secret), original.connectionId);
      }
    } catch (error) {
      message.value =
        error instanceof Error && error.message === 'key_resupply_required'
          ? 'Введите тот же исходный ключ.'
          : settingsError(error);
    }
  }
  async function check() {
    key.value = '';
    const entry = current.value;
    if (busy.value || stale.value || !entry || entry.recovery || pending.value) return;
    const selection = selectionVersion;
    busy.value = true;
    try {
      const reply = await request({
        op: 'model-check',
        input: { connectionId: entry.connectionId },
      });
      if (
        reply.status.connectionId !== entry.connectionId ||
        reply.check.connectionId !== entry.connectionId
      )
        throw Error('invalid_frame');
      await load();
      // load replaces the same selection; a user selection change never receives old check feedback.
      if (selected.value === entry.connectionId && selection + 1 === selectionVersion) {
        checkResult.value = connectionCheckLine(reply, current.value?.revision);
      }
    } catch (error) {
      await load();
      if (selected.value === entry.connectionId) message.value = settingsError(error);
    } finally {
      busy.value = false;
    }
  }
  return {
    connections,
    presets,
    selected,
    key,
    busy,
    stale,
    message,
    pending,
    checkResult,
    draft,
    current,
    canEdit,
    writeRestriction,
    select,
    propose,
    close,
    load,
    save,
    revisionAction,
    recover,
    check,
  };
}

export const connectionSettings = createConnectionSettings();
