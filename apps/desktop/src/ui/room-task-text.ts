import type { RoomTaskRow, RoomTaskRootView } from '@runnets/contracts';
import type { Bot } from '../protocol.js';
import { botModels } from './bot-model-state.js';
import { connectionSettings } from './model-connection-state.js';
export function taskModelText(bot: Bot) {
  const binding = botModels.bots.value.find((x) => x.bot.id === bot.id)?.binding;
  const c = connectionSettings.connections.value.find(
    (x) => x.connectionId === binding?.connectionId,
  );
  if (!binding || !c) return `${bot.model} · привязка неизвестна`;
  const model = c.models.find((x) => x.modelId === binding.modelId);
  const stale = botModels.stale.value || connectionSettings.stale.value;
  return `${c.kind === 'cloud' ? 'Облако' : 'Локально'} · ${c.connectionId} / ${binding.modelId} · ${stale ? 'данные устарели' : c.restriction || c.configuration.intent !== 'active' ? 'недоступно' : c.lastCheck?.revision === c.revision && c.lastCheck.outcome === 'ok' ? 'проверено' : 'не проверено'} · ввод: ${model?.capabilities.inputModalities.join(', ') ?? 'неизвестен'}`;
}
export function taskRowText(
  row: RoomTaskRow,
  view: RoomTaskRootView,
  label: (id: string) => string,
): string {
  if (row.type === 'task') {
    const peer = view.rows.find((x) => x.type === 'task' && x.id === row.waitingChildId);
    return `${row.botId ? label(row.botId) : 'Корень'} · ${row.status}${row.waitingChildId ? ` · ждёт ${peer?.type === 'task' && peer.botId ? label(peer.botId) : row.waitingChildId}` : ''} · ${row.hold ?? 'без удержания'}`;
  }
  if (row.type === 'delivery')
    return `${row.kind} · ${row.state} · ${row.hold ?? 'без удержания'} · сообщение ${row.messageId} / ${row.seq}`;
  return `${row.runId} · ${row.turnStatus} / ${row.taskStatus} · ${row.disposition === 'yielded' ? 'передал ход, итогового ответа нет' : row.resultMessageId ? `ответ: ${row.resultMessageId}` : 'итоговый ответ не подтверждён'} · ${row.hold ?? 'без удержания'}`;
}
export function addressedTarget(author: string | undefined, target: string | null) {
  return target && author !== target ? target : null;
}
