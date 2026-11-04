import type { Run } from '../protocol.js';

export const turnText: Record<Run['turnStatus'], string> = {
  queued: 'В очереди рассылки',
  accepted: 'Запрос принят',
  dispatching: 'Готовим ответ…',
  prepared: 'Отвечает…',
  completed: 'Ответил',
  failed: 'Не удалось получить ответ',
  uncertain: 'Исход ответа не подтверждён',
  cancelled: 'Остановлено',
};
export function runText(run: Run, handle: string) {
  if (run.turnStatus === 'prepared') return `@${handle} отвечает…`;
  if (run.turnStatus === 'completed') return `@${handle} ответил`;
  return turnText[run.turnStatus];
}
export function historyState(error: string, count: number, busy: boolean) {
  return error ? 'error' : !count && !busy ? 'empty' : 'messages';
}
export function feedbackText(text: string, code: string, welcome: boolean) {
  return welcome && code === 'runtime_absent' ? '' : text;
}

/**
 * One receipt contract for every successful submission: confidence is proven by
 * the durable receipt, never by the wording, so a broadcast cannot fall into the
 * unconfirmed branch of the shared feedback row.
 */
export function receiptLabel(receipt: string, accepted = false): string {
  const confirmed = accepted || receipt.startsWith('Принято');
  if (!confirmed) return 'Квитанция не подтверждена';
  return receipt.includes('Всем') || receipt.startsWith('Принято · Всем')
    ? 'Рассылка принята'
    : 'Сообщение принято';
}
