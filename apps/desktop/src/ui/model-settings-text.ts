import type { LocalModelConnectionCheckResponse } from '@runnets/contracts';
import { explain } from './dom.js';
export const conflictText =
  'Данные изменены в другом окне. Проверьте обновлённые значения и подтвердите новое действие.';
export const unknownText =
  'Исход операции неизвестен. Обновите метаданные и явно завершите исходную операцию с тем же вводом. Новый запрос не создан.';
export function unknownOutcome(error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  return (
    [
      'outcome_unknown',
      'invalid_frame',
      'runtime_timeout',
      'runtime_disconnected',
      'runtime_unavailable',
      'runtime_unreachable',
      'connection_closed',
      'frame_too_large',
      'runtime_not_running',
    ].includes(code) ||
    !(error instanceof Error) ||
    !/^[a-z_]+$/.test(code)
  );
}
export function settingsError(error: unknown): string {
  if (unknownOutcome(error)) return unknownText;
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    model_support_changed:
      'Возможности хоста изменились во время выбора. Обновите метаданные и явно выберите подключение и модель заново.',
    model_runtime_upgrade_required: 'Этому хосту требуется обновление для настроек подключений.',
    connection_not_found: 'Подключение не найдено. Обновите метаданные.',
    connection_unverified: 'Подключение не подтверждено. Проверьте состояние и исходную операцию.',
    provider_unverified:
      'Сохранённая ссылка не подтверждена. Проверьте восстановление исходной операции.',
    provider_write_failed: 'Операция не завершена. Обновите метаданные для точного восстановления.',
    local_model_unqualified: 'Локальная модель не квалифицирована. Выполните явную проверку.',
    model_tools_unsupported: 'Модель не поддерживает инструменты. Выберите совместимую модель.',
    model_image_input_unsupported:
      'Модель не поддерживает изображения. Выберите совместимую модель.',
  };
  return messages[code] ?? explain(error);
}

export function connectionCheckLine(
  reply: LocalModelConnectionCheckResponse,
  observedRevision?: number,
): string {
  const { check, status } = reply;
  const stale = observedRevision !== undefined && check.revision !== observedRevision;
  return `${check.outcome} · ${check.checkedAt} · проверена версия ${check.revision} · ${check.source} · ${check.persisted ? 'сохранено' : 'не сохранено'}${stale ? ' · устарела' : ''}; состояние в ответе проверки: ${status.state}, версия ${status.revision}`;
}
