import { computed, ref, shallowRef, watch } from 'vue';
import type { ProviderStatus } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';
import { providerCheckText } from './provider-text.js';
import { settingsError, unknownOutcome, unknownText } from './model-settings-text.js';
import {
  legacyOriginal,
  legacyResupply,
  sameLegacyOriginal,
  type LegacyMutation,
  type LegacyOriginal,
} from './provider-recovery.js';
export const providerStatus = ref<ProviderStatus | null>(null);
export const providerBusy = ref(false),
  providerKey = ref(''),
  providerModel = ref(''),
  providerMessage = ref(''),
  providerError = ref(false),
  providerCode = ref(''),
  providerStale = ref(true);
export const providerPending = shallowRef<LegacyOriginal | null>(null);
export const providerModels = computed<readonly string[]>(() => providerStatus.value?.models ?? []);
export const providerDefaultModel = computed(
  () => providerStatus.value?.model ?? providerStatus.value?.models[0] ?? '',
);
export const providerCanSave = computed(() => {
  const status = providerStatus.value;
  if (!status?.writable || providerPending.value || providerStale.value) return false;
  return providerKey.value.trim() !== '' || (status.savedKey && status.state !== 'unverified');
});
watch(
  providerModel,
  () => {
    providerKey.value = '';
  },
  { flush: 'sync' },
);
function apply(status: ProviderStatus) {
  providerStatus.value = status;
  if (status.model !== null) providerModel.value = status.model;
}
function failure(error: unknown) {
  providerCode.value = error instanceof Error ? error.message : String(error);
  providerMessage.value = settingsError(error);
  providerError.value = true;
}
let readGeneration = 0;
export async function loadProviderStatus(): Promise<void> {
  providerKey.value = '';
  const token = ++readGeneration;
  providerStale.value = true;
  try {
    const status = await call({ op: 'provider' });
    if (token === readGeneration) {
      apply(status);
      providerStale.value = false;
    }
  } catch (error) {
    if (token === readGeneration) failure(error);
  }
}
async function run(command: LegacyMutation, success: string) {
  if (providerBusy.value || providerStale.value) return;
  const original = legacyOriginal(command),
    pending = providerPending.value;
  if (pending && !sameLegacyOriginal(pending, original)) return;
  providerBusy.value = true;
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
  try {
    await call(command);
    if (providerPending.value && sameLegacyOriginal(providerPending.value, original))
      providerPending.value = null;
    await loadProviderStatus();
    providerMessage.value = providerStale.value
      ? 'Исходная операция подтверждена; текущее состояние не прочитано. Обновите метаданные.'
      : success;
  } catch (error) {
    if (
      unknownOutcome(error) ||
      (error instanceof Error && error.message === 'provider_write_failed')
    )
      providerPending.value = original;
    await loadProviderStatus();
    failure(error);
    if (providerPending.value) providerMessage.value = unknownText;
  } finally {
    providerBusy.value = false;
  }
}
export function clearProviderInput() {
  providerKey.value = '';
}
export function requireProviderDefaultModel(): string {
  if (!providerDefaultModel.value) throw Error('provider_unavailable');
  return providerDefaultModel.value;
}
export async function checkProvider() {
  clearProviderInput();
  if (providerBusy.value || providerPending.value) return;
  providerBusy.value = true;
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
  try {
    const reply = await call({ op: 'provider-check' });
    apply(reply.status);
    providerStale.value = false;
    providerMessage.value =
      providerCheckText[reply.check.outcome] +
      (reply.check.persisted ? ' · результат сохранён.' : ' · результат не сохранён.');
  } catch (error) {
    failure(error);
  } finally {
    providerBusy.value = false;
  }
}
export async function saveProvider() {
  const key = providerKey.value;
  clearProviderInput();
  if (providerBusy.value || providerPending.value) return;
  const status = providerStatus.value;
  if (
    !status?.writable ||
    providerStale.value ||
    (!key.trim() && (!status.savedKey || status.state === 'unverified'))
  ) {
    providerMessage.value =
      status?.state === 'unverified' ? explain('provider_unverified') : 'Введите ключ API.';
    providerError.value = true;
    return;
  }
  await run(
    {
      op: 'provider-set',
      requestId: crypto.randomUUID(),
      model: providerModel.value || providerDefaultModel.value,
      ...(key.trim() ? { key } : {}),
    },
    key.trim() ? 'Ключ сохранён. Текущее состояние прочитано отдельно.' : 'Выбрана модель.',
  );
}
export async function disconnectProvider() {
  clearProviderInput();
  const status = providerStatus.value;
  if (!status?.writable || providerPending.value) return;
  await run(
    {
      op: 'provider-disconnect',
      requestId: crypto.randomUUID(),
      expectedRevision: status.revision,
    },
    'Провайдер отключён. Ключ DeepSeek не отозван.',
  );
}
export async function removeSavedProviderKey() {
  clearProviderInput();
  const status = providerStatus.value;
  if (!status?.writable || providerPending.value) return;
  await run(
    {
      op: 'provider-remove-key',
      requestId: crypto.randomUUID(),
      expectedRevision: status.revision,
    },
    'Сохранённый ключ Ocean удалён. Ключ DeepSeek не отозван.',
  );
}
export async function recoverProvider() {
  const key = providerKey.value;
  clearProviderInput();
  const original = providerPending.value;
  if (!original || providerBusy.value || providerStale.value || !providerStatus.value?.writable)
    return;
  try {
    await run(
      legacyResupply(original, key),
      'Исходная операция подтверждена. Текущее состояние прочитано отдельно.',
    );
  } catch (error) {
    providerMessage.value =
      error instanceof Error && error.message === 'key_resupply_required'
        ? 'Введите тот же исходный ключ.'
        : settingsError(error);
    providerError.value = true;
  }
}
export function resetProviderState() {
  ++readGeneration;
  providerStatus.value = null;
  providerBusy.value = false;
  providerKey.value = '';
  providerModel.value = '';
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
  providerPending.value = null;
  providerStale.value = true;
}

export function legacyProviderBlocks(connectionId: string): boolean {
  return (
    connectionId === 'legacy:deepseek' && (providerPending.value !== null || providerBusy.value)
  );
}
