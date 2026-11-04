import type { BroadcastBatch, BroadcastChild } from '../protocol.js';

export const broadcastStateText: Record<BroadcastBatch['state'], string> = {
  open: 'Рассылка идёт',
  paused: 'Рассылка приостановлена',
  completed: 'Рассылка завершена',
  abandoned: 'Рассылка оставлена',
};
export const broadcastChildText: Record<BroadcastChild['state'], string> = {
  queued: 'Ожидает очереди',
  running: 'Отвечает…',
  answered: 'Ответил',
  refused: 'Не начат: отказ',
  uncertain: 'Исход не подтверждён',
  cancelled: 'Остановлен',
  not_started: 'Не начат',
};
export function broadcastSummary(batch: BroadcastBatch): string {
  const answered = batch.recipients.filter((child) => child.state === 'answered').length;
  const total = batch.recipients.length;
  return `${broadcastStateText[batch.state]} · ${answered} из ${total} ответили · ревизия ${batch.revision}`;
}
export function broadcastChildLine(child: BroadcastChild): string {
  const base = `@${child.handle} — ${broadcastChildText[child.state]} · ${child.model}`;
  return child.state === 'answered' && child.resultMessageId !== null
    ? base + ' · ' + child.resultMessageId
    : base;
}
export function broadcastPaused(batch: BroadcastBatch | null): boolean {
  return batch?.state === 'paused';
}
export function broadcastBlocksNewTurns(batch: BroadcastBatch | null): boolean {
  return batch?.state === 'open' || batch?.state === 'paused';
}

/** Why an addressed or broadcast send is blocked while a batch holds the room. */
export function sendBlockedHint(batch: BroadcastBatch | null, recipient: string): string {
  if (!broadcastBlocksNewTurns(batch) || recipient === '') return '';
  return 'Панель рассылки ждёт решения: вопросы модели недоступны, заметка отправится без модели.';
}
