import { computed, reactive, ref, watch } from 'vue';
import type {
  LocalModelConnectionMetadata,
  LocalModelConnectionSetRequest,
  ModelPreset,
} from '../model-protocol.js';
import { call } from './bridge.js';
import { legacyProviderBlocks } from './provider-state.js';
import { modelPages } from './model-pages.js';
import {
  createConnectionIntents,
  keylessRecoveryForSelection,
  sharedConnectionIntents,
} from './connection-intents.js';
import { connectionOperations } from './connection-operations.js';
import { settingsError, connectionCheckLine } from './model-settings-text.js';
import { recoveryCommand, resupply } from './model-settings-recovery.js';
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
export function createConnectionSettings(
  request: typeof call = call,
  intents = createConnectionIntents(),
) {
  const connections = ref<LocalModelConnectionMetadata[]>([]),
    presets = ref<ModelPreset[]>([]);
  const selected = ref(''),
    key = ref(''),
    busy = ref(false),
    stale = ref(true),
    message = ref('');
  const pending = computed(() => intents.entries.get(selected.value) ?? null);
  const pendingEntries = computed(() => [...intents.entries.values()]);
  const checkResult = ref('');
  const draft = reactive<Draft>(empty());
  const current = computed(() => connections.value.find((x) => x.connectionId === selected.value));
  const writeRestriction = computed(
    () => connections.value.find((x) => x.restriction !== null)?.restriction ?? null,
  );
  const legacyBlocked = computed(() =>
    legacyProviderBlocks(selected.value || draft.connectionId, pending.value),
  );
  const canEdit = computed(
    () =>
      !busy.value &&
      !stale.value &&
      !pending.value &&
      !legacyBlocked.value &&
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
        : { ...empty(), connectionId: id },
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
  const mutate = connectionOperations(request, {
    busy,
    stale,
    message,
    connections,
    load,
    select,
    intents,
  });
  async function save(repair = false) {
    const secret = key.value;
    key.value = '';
    const entry = current.value;
    if (legacyBlocked.value) {
      message.value = 'Сначала завершите сохранённую старую provider-операцию этого подключения.';
      return;
    }
    if (!entry && intents.entries.has(draft.connectionId)) {
      select(draft.connectionId);
      message.value = 'Сначала завершите сохранённый исходный запрос этого подключения.';
      return;
    }
    if (repair && (!secret.trim() || draft.auth !== 'api_key')) {
      message.value = 'Для отдельного исправления выберите API key и введите новый ключ.';
      return;
    }
    if (
      repair
        ? !entry?.writable ||
          entry.recovery?.kind !== 'explicit_key_repair_required' ||
          !secret.trim() ||
          pending.value
        : !canEdit.value
    )
      return;
    if (busy.value || stale.value) return;
    const input = {
      ...draft,
      requestId: crypto.randomUUID(),
      expectedRevision: entry?.revision ?? null,
      ...(draft.auth === 'api_key' && secret.trim() ? { key: secret } : {}),
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
    const secret = key.value;
    key.value = '';
    if (busy.value || stale.value || legacyBlocked.value) return;
    try {
      const entry = current.value;
      if (entry && !entry.writable) return;
      const local = pending.value;
      if (entry?.recovery?.kind === 'retry_available') {
        const command = recoveryCommand(entry.recovery.request, secret);
        if (
          command.op !== 'model-set' &&
          command.op !== 'model-remove-key' &&
          command.op !== 'provider-set' &&
          command.op !== 'provider-remove-key'
        )
          throw Error('invalid_request');
        await mutate(command, entry.connectionId, true);
      } else if (local && keylessRecoveryForSelection(local, entry, selected.value)) {
        await mutate(resupply(local, secret), local.connectionId, true);
      } else if (local)
        message.value =
          'Текущее описание относится к другой операции. Исходный запрос сохранён без изменений.';
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
    if (
      busy.value ||
      stale.value ||
      !entry ||
      entry.recovery ||
      pending.value ||
      legacyBlocked.value
    )
      return;
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
    pendingEntries,
    legacyBlocked,
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

export const connectionSettings = createConnectionSettings(call, sharedConnectionIntents);
