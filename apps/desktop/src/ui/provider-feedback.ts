/** A retired bot model is a different owner problem from a missing provider configuration. */
import { modelSupport } from './model-support.js';
import type { Bot, Room } from '../protocol.js';
import { providerModels } from './provider-state.js';
import { retiredModelHint } from './provider-text.js';

export function unavailableFeedback(
  code: string,
  room: Room | undefined,
  recipient: string,
  bots: readonly Bot[],
): string | null {
  if (code !== 'provider_unavailable' || !room) return null;
  if (modelSupport.value === true)
    return 'Проверьте точную привязку бота и состояние его подключения в настройках провайдера.';
  const candidates =
    room.kind === 'direct' ? [room.botId] : recipient !== '' ? [recipient] : room.botIds;
  for (const id of candidates) {
    const hint = retiredModelHint(
      bots.find((bot) => bot.id === id)?.model ?? null,
      providerModels.value,
    );
    if (hint !== null) return hint;
  }
  return null;
}
