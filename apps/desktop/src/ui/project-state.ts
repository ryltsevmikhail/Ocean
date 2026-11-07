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
  project_changed: 'Проект изменился. Обновите состояние и проверьте снимок.',
  recovery_required: 'Сервер требует восстановления перед новым действием.',
  unknown_decision: 'Запись подтверждения пока не найдена. Проверьте состояние исходной операции.',
  unknown_project: 'Проект больше не зарегистрирован. Обновите список.',
  runtime_draining: 'Сервер завершает работу. Подключитесь заново после запуска.',
  invalid_params: 'Сервер отклонил параметры. Проверьте состояние и версию Ocean.',
  provider_unavailable: 'Назначенной модели сейчас нельзя отправить запрос.',
};
export const projectError = (error: unknown) =>
  errors[error instanceof Error ? error.message : ''] ??
  'Состояние не подтверждено. Обновите его перед новым действием.';

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

// The first request acknowledges a card before its effect. These replies refuse admission;
// transport failure, conflict or recovery_required cannot establish that a request is absent.
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
    if (error instanceof Error && projectRefusals.has(error.message)) restore();
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
]);
export const projectSendRefused = (error: unknown) =>
  error instanceof Error && sendRefused.has(error.message);
