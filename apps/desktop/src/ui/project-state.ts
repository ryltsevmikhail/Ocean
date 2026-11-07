import { LOCAL_PROJECT_PRE_CARD_REFUSAL } from '@runnets/contracts';

const statuses: Record<string, string> = {
  reserved: 'Зарезервировано',
  pending: 'Ожидает решения владельца',
  allowed: 'Разрешение записано; результат ещё не подтверждён',
  prepared: 'Рабочая копия подготовлена',
  existing: 'Рабочая копия уже подготовлена',
  unconfirmed: 'Подтверждения результата нет',
  outcome_unknown: 'Исход неизвестен',
  uncertain: 'Исход неизвестен',
  applying: 'Применение выполняется',
  no_application: 'Применение не подтверждено',
  no_review: 'Ревью не подтверждено',
  not_started: 'Эффект не начался',
  completed: 'Завершено',
  cancelled: 'Отмена подтверждена',
  denied: 'Отклонено владельцем',
  expired: 'Срок решения истёк',
  invalidated: 'Решение устарело',
  interrupted: 'Прервано; проверьте сохранённый результат',
  requested: 'Запрос зарегистрирован',
  queued: 'В очереди',
  accepted: 'Принято',
  dispatching: 'Выполняется',
  failed: 'Ошибка выполнения',
  finalizing: 'Завершение задачи',
  finalized: 'Задача закрыта',
};
export const projectStatus = (status: string) => statuses[status] ?? 'Нет подтверждённого статуса';

const errors: Record<string, string> = {
  project_runtime_upgrade_required: 'Эта версия сервера не поддерживает проекты. Обновите Ocean.',
  project_identity_changed:
    'Сервер сменился. Подключитесь заново, чтобы прочитать сохранённое состояние.',
  profile_missing: 'Профиль Ocean недоступен. Запустите сервер для этого профиля.',
  client_busy: 'Сервер занят. Обновите состояние.',
  version_conflict: 'Карточка изменилась. Перечитайте её перед решением.',
  decision_scope_changed: 'Решение больше не относится к выбранной операции.',
  coding_denied: 'Операция недоступна для выбранной задачи и комнаты.',
  request_conflict: 'Запрос не совпадает с сохранённым. Проверьте исходную операцию.',
  invalid_request: 'Проверьте заполнение полей.',
  context_limit: 'Сообщение не помещается в контекст комнаты. Сократите текст и отправьте снова.',
  run_version_conflict: 'Статус запуска изменился. Проверьте его перед новым запросом отмены.',
  run_not_started: 'Запуск ещё не начался. Дождитесь обновления статуса.',
  run_not_active: 'У этого запуска больше нет активного выполнения для отмены.',
  project_changed: 'Проект изменился. Обновите состояние и проверьте снимок.',
  recovery_required: 'Сервер требует восстановления перед новым действием.',
  unknown_decision: 'Запись подтверждения пока не найдена. Проверьте состояние исходной операции.',
  unknown_project: 'Проект больше не зарегистрирован. Обновите список.',
  runtime_draining: 'Сервер завершает работу. Подключитесь заново после запуска.',
  invalid_params: 'Сервер отклонил параметры. Проверьте состояние и версию Ocean.',
  provider_unavailable: 'Назначенной модели сейчас нельзя отправить запрос.',
  catalog_unavailable:
    'Каталог проектов или его зависимости недоступны. Проверьте их и повторите запрос.',
  model_transfer_denied: 'Политика комнаты запрещает отправлять снимок назначенной модели.',
  model_policy_unavailable:
    'Политика комнаты ревью недоступна. Восстановите её и повторите запрос.',
};
const preCardReason = (code: string) =>
  code.startsWith(LOCAL_PROJECT_PRE_CARD_REFUSAL)
    ? code.slice(LOCAL_PROJECT_PRE_CARD_REFUSAL.length)
    : '';
export function projectError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const reason = preCardReason(code);
  if (reason === 'request_conflict')
    return 'Идентификатор задачи уже используется. Укажите свободный идентификатор.';
  return (
    errors[reason || code] ??
    (reason
      ? 'Сервер отказал до открытия карточки подтверждения.'
      : 'Состояние не подтверждено. Обновите его перед новым действием.')
  );
}

export function projectActions(input: {
  ready: boolean;
  active: boolean;
  uncertain: boolean;
  hash: string;
  reviewedHash: string;
  approved: boolean;
  stale: boolean;
}) {
  const idle = input.ready && !input.active && !input.uncertain;
  return {
    send: idle,
    capture: idle,
    review: idle && Boolean(input.hash),
    apply:
      idle &&
      Boolean(input.hash) &&
      input.hash === input.reviewedHash &&
      input.approved &&
      !input.stale,
  };
}

// A setup job can prove it refused admission before attempting to open its card.
// Untagged conflict, recovery and transport errors cannot establish that the request is absent.
const projectRefusals = new Set([
  'invalid_request',
  'invalid_params',
  'invalid_input',
  'provider_unavailable',
  'coding_denied',
  'project_changed',
  'unknown_project',
  'unknown_coding_task',
  'worktree_unavailable',
  'changeset_limit',
  'unsupported_file',
  'client_busy',
  'query_limit',
  'runtime_draining',
  'project_identity_changed',
  'project_runtime_upgrade_required',
]);
export async function projectAdmission<T>(request: () => Promise<T>, restore: () => void) {
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof Error &&
      (preCardReason(error.message) || projectRefusals.has(error.message))
    )
      restore();
    throw error;
  }
}

const sendRefused = new Set([
  'invalid_request',
  'invalid_params',
  'invalid_input',
  'provider_unavailable',
  'coding_denied',
  'room_busy',
  'recovery_required',
  'context_limit',
  'runtime_draining',
  'workspace_conflict',
  'unknown_room',
  'unknown_bot',
  'not_member',
  'batch_open',
  'model_policy_unavailable',
  'model_transfer_denied',
  'model_image_unsupported',
  'image_unavailable',
  'image_too_large',
  'request_too_large',
  'client_busy',
  'project_identity_changed',
  'project_runtime_upgrade_required',
]);
export const projectSendRefused = (error: unknown) =>
  error instanceof Error && sendRefused.has(error.message);

// Do not parse and re-serialize owner previews: that can turn visible JSON
// escapes back into formatting controls and change how a bound path looks.
export const projectDecisionText = (text: string) =>
  text.replace(
    /[\p{Bidi_Control}\u2028\u2029]/gu,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );
