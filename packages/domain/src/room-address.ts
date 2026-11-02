import { ok } from './errors.js';
import { conversationFailure, type ConversationResult } from './conversations.js';
/** Only an explicit leading mention or caller-selected recipient determines routing. */
export function roomAddress(
  text: string,
  to: string | undefined,
): ConversationResult<string | null> {
  const leading = /^\s*@([a-z][a-z0-9_-]{0,31})(?=\s|$)/.exec(text);
  if (leading === null && /^\s*@/.test(text)) return conversationFailure('invalid_input');
  const mentioned = leading?.[1];
  if (leading !== null && /^\s*@/.test(text.slice(leading[0].length)))
    return conversationFailure('invalid_input');
  if (mentioned !== undefined && to !== undefined && mentioned !== to)
    return conversationFailure('invalid_input');
  return ok(to ?? mentioned ?? null);
}
