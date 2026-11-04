import { computed, ref } from 'vue';
import type { ProviderStatus } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';
import { providerCheckText } from './provider-text.js';

/** Shared provider settings state; one runtime, one visible connection. */
export const providerStatus = ref<ProviderStatus | null>(null);
export const providerBusy = ref(false);
export const providerKey = ref('');
export const providerModel = ref('');
export const providerMessage = ref('');
export const providerError = ref(false);
export const providerCode = ref('');
export const providerModels = computed<readonly string[]>(() => providerStatus.value?.models ?? []);
export const providerDefaultModel = computed<string>(
  () => providerStatus.value?.model ?? providerStatus.value?.models[0] ?? '',
);
export const providerCanSave = computed<boolean>(() => {
  const status = providerStatus.value;
  if (status === null || !status.writable) return false;
  return providerKey.value.trim() !== '' || status.savedKey;
});
export const providerKeyInvalid = computed<boolean>(
  () => providerKey.value.trim() === '' && !(providerStatus.value?.savedKey ?? false),
);
function apply(status: ProviderStatus): void {
  providerStatus.value = status;
  if (status.model !== null) providerModel.value = status.model;
}
function failure(error: unknown): void {
  providerCode.value = error instanceof Error ? error.message : String(error);
  providerMessage.value = explain(error);
  providerError.value = true;
}
async function run(action: () => Promise<ProviderStatus>, success: string): Promise<void> {
  if (providerBusy.value) return;
  providerBusy.value = true;
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
  try {
    apply(await action());
    providerMessage.value = success;
  } catch (error) {
    failure(error);
  } finally {
    providerBusy.value = false;
  }
}
/** Read-only refresh; a missing runtime leaves the settings panel unavailable, not broken. */
export async function loadProviderStatus(): Promise<void> {
  try {
    apply(await call({ op: 'provider' }));
  } catch (error) {
    providerCode.value = error instanceof Error ? error.message : String(error);
    providerError.value = true;
    providerMessage.value = explain(error);
  }
}
export async function checkProvider(): Promise<void> {
  if (providerBusy.value) return;
  providerBusy.value = true;
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
  try {
    const reply = await call({ op: 'provider-check' });
    apply(reply.status);
    providerMessage.value =
      providerCheckText[reply.check.outcome] +
      (reply.check.persisted ? ' · результат сохранён.' : ' · результат не сохранён.');
  } catch (error) {
    failure(error);
  } finally {
    providerBusy.value = false;
  }
}
/** Save (or replace) the transient key and the selected model. Input is cleared afterwards. */
export async function saveProvider(): Promise<void> {
  const status = providerStatus.value;
  if (status === null || !providerCanSave.value) {
    providerMessage.value = 'Введите ключ API.';
    providerError.value = true;
    return;
  }
  const key = providerKey.value.trim();
  try {
    await run(
      () =>
        call({
          op: 'provider-set',
          requestId: crypto.randomUUID(),
          model: providerModel.value || providerDefaultModel.value,
          ...(key === '' ? {} : { key }),
        }),
      key === '' ? 'Выбрана модель.' : 'Ключ сохранён.',
    );
  } finally {
    providerKey.value = '';
  }
}
export async function disconnectProvider(): Promise<void> {
  const status = providerStatus.value;
  if (status === null || !status.writable) return;
  await run(
    () =>
      call({
        op: 'provider-disconnect',
        requestId: crypto.randomUUID(),
        expectedRevision: status.revision,
      }),
    'Провайдер отключён. Ключ DeepSeek не отозван.',
  );
}
export async function removeSavedProviderKey(): Promise<void> {
  const status = providerStatus.value;
  if (status === null || !status.writable) return;
  await run(
    () =>
      call({
        op: 'provider-remove-key',
        requestId: crypto.randomUUID(),
        expectedRevision: status.revision,
      }),
    'Сохранённый ключ Ocean удалён. Ключ DeepSeek не отозван.',
  );
}
/** Test-only reset: component state never survives a window. */
export function resetProviderState(): void {
  providerStatus.value = null;
  providerBusy.value = false;
  providerKey.value = '';
  providerModel.value = '';
  providerMessage.value = '';
  providerError.value = false;
  providerCode.value = '';
}
