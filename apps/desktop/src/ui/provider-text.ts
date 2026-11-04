import type { ProviderCheck, ProviderStatus } from '../protocol.js';

type ProviderCheckMetadata = Omit<ProviderCheck, 'persisted'>;

export const providerSourceText: Record<ProviderStatus['source'], string> = {
  saved: 'Ключ Ocean',
  external: 'Ключ окружения',
  injected: 'Тестовый провайдер',
  none: 'Не настроено',
};
export const providerStateText: Record<ProviderStatus['state'], string> = {
  connected: 'Подключено',
  disconnected: 'Отключено',
  unverified: 'Требуется повторить настройку',
  absent: 'Ключ не задан',
  restored: 'Восстановленный профиль',
  invalid_model: 'Модель не поддерживается',
};
export const providerCheckText: Record<ProviderCheck['outcome'], string> = {
  ok: 'Список моделей получен',
  auth: 'Ключ отклонён',
  network: 'Сеть недоступна',
  timeout: 'Время проверки истекло',
  server: 'Сервер провайдера недоступен',
  unavailable: 'Проверка недоступна',
};
/** Real status line: state, source, selected model and revision, never credentials. */
export function providerStatusLine(status: ProviderStatus): string {
  const model = status.model === null ? 'модель не выбрана' : status.model;
  return `${providerStateText[status.state]} · ${providerSourceText[status.source]} · ${model} · ревизия ${status.revision}`;
}
/** Bounded check line; no vendor body text and no key fragment. */
export function providerCheckLine(check: ProviderCheckMetadata): string {
  const models = check.models.length === 1 ? '1 модель' : `${check.models.length} моделей`;
  const supported = check.modelSupported
    ? 'выбранная модель поддерживается'
    : 'выбранная модель не подтверждена';
  return `Проверка: ${providerCheckText[check.outcome]} · ${models} · ${supported} · ${check.durationMs} мс`;
}
/** Masked input hint; the key value itself never reaches this module. */
export function providerKeyHint(key: string, savedKey: boolean): string {
  if (key.trim() !== '')
    return savedKey
      ? 'Будет заменён сохранённый ключ Ocean.'
      : 'Ключ будет сохранён только локальным runtime.';
  if (savedKey) return 'Оставьте поле пустым, чтобы применить только выбранную модель.';
  return 'Введите ключ API, чтобы сохранить подключение.';
}
export function providerCapabilitySuffix(imageInput: boolean): string {
  return imageInput ? ' · текст и изображения' : ' · только текст';
}
