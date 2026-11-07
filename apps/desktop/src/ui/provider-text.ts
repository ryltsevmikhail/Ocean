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
  cancelled: 'Проверка отменена',
  server: 'Сервер провайдера недоступен',
  unavailable: 'Проверка недоступна',
};
/** Real status line: state, source, selected model and revision, never credentials. */
export function providerStatusLine(status: ProviderStatus): string {
  const model = status.model === null ? 'модель не выбрана' : status.model;
  return `${providerStateText[status.state]} · ${providerSourceText[status.source]} · ${model} · ревизия ${status.revision}`;
}
/**
 * Bounded check line; no vendor body text and no key fragment. When the live connection
 * moved on since the stored check (rotation, removal, external switch), the line says so
 * instead of presenting the old result as current.
 */
export function providerCheckLine(
  check: ProviderCheckMetadata,
  current?: Pick<ProviderStatus, 'revision' | 'source'>,
): string {
  const stale =
    current !== undefined &&
    (current.revision !== check.revision || current.source !== check.source);
  const models = check.models.length === 1 ? '1 модель' : `${check.models.length} моделей`;
  const supported = check.modelSupported
    ? 'выбранная модель поддерживается'
    : 'выбранная модель не подтверждена';
  return `${stale ? 'Проверка устарела' : 'Проверка'}: ${providerCheckText[check.outcome]} · ${models} · ${supported} · ${check.durationMs} мс`;
}
/** Owner-visible hint when a persisted bot model is no longer advertised; never guesses. */
export function retiredModelHint(
  botModel: string | null,
  models: readonly string[],
): string | null {
  if (botModel === null || models.length === 0 || models.includes(botModel)) return null;
  return `Модель бота «${botModel}» больше не объявлена провайдером. Создайте бота с моделью из списка.`;
}
/** Masked input hint; the key value itself never reaches this module. */
export function providerKeyHint(
  key: string,
  savedKey: boolean,
  state?: ProviderStatus['state'],
  code?: ProviderStatus['code'],
): string {
  if (code === 'provider_secret_corrupt' || code === 'provider_secret_insecure')
    return 'Приватное хранилище требует отдельного безопасного исправления. Повреждённые данные сохранены; повторный ввод ключа не исправляет хранилище.';
  if (key.trim() !== '')
    return savedKey
      ? 'Будет заменён сохранённый ключ Ocean.'
      : 'Ключ будет сохранён только локальным runtime.';
  if (state === 'unverified' && savedKey)
    return 'Сохранённый ключ не удалось подтвердить. Введите ключ заново явно, если действительная ссылка отсутствует.';
  if (savedKey) return 'Оставьте поле пустым, чтобы применить только выбранную модель.';
  return 'Введите ключ API, чтобы сохранить подключение.';
}
export function providerCapabilitySuffix(imageInput: boolean): string {
  return imageInput ? ' · текст и изображения' : ' · только текст';
}
