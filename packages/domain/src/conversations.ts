import { err, ok, type Result } from './errors.js';

export interface Workspace {
  readonly id: string;
  readonly root: string;
}
export interface Bot {
  readonly id: string;
  readonly workspaceId: string;
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly profileVersion: number;
}
export interface DirectRoom {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: 'direct';
  readonly botId: string;
}
export interface GroupRoom {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: 'group';
  readonly title: string;
  readonly botIds: readonly string[];
}
export type Room = DirectRoom | GroupRoom;
export interface ConversationMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly seq: number;
  readonly author: 'user' | 'bot';
  readonly authorBotId?: string;
  readonly turnId?: string;
  readonly targetBotId: string | null;
  readonly body: string;
  readonly createdAt: string;
}
export type ConversationErrorCode =
  | 'invalid_input'
  | 'admission_closed'
  | 'request_conflict'
  | 'workspace_conflict'
  | 'handle_taken'
  | 'unknown_bot'
  | 'review_conflict'
  | 'review_unavailable'
  | 'approval_required'
  | 'not_member'
  | 'unknown_room'
  | 'room_busy'
  | 'recovery_required'
  | 'provider_unavailable'
  | 'context_limit';
export interface ConversationError {
  readonly code: ConversationErrorCode;
  readonly message: string;
}
export type ConversationResult<T> = Result<T, ConversationError>;
export type BotProfileInput = Pick<Bot, 'handle' | 'name' | 'role' | 'provider' | 'model'>;

/** Bound Unicode input by UTF-8 bytes without admitting malformed surrogate pairs. */
export function validConversationText(text: string, maxBytes: number): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false;
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return false;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) return false;
  }
  return true;
}
/** Expected conversation failures are data, never thrown domain exceptions. */
export function conversationFailure(code: ConversationErrorCode): ConversationResult<never> {
  return err({ code, message: code.replaceAll('_', ' ') });
}
/** Validate the complete profile before allocating identity or committing a record. */
export function validateBotProfile(input: BotProfileInput): ConversationResult<BotProfileInput> {
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/.test(input.handle) ||
    !validConversationText(input.name, 256) ||
    !validConversationText(input.role, 8192) ||
    !validConversationText(input.provider, 128) ||
    !validConversationText(input.model, 256)
  )
    return conversationFailure('invalid_input');
  return ok({
    handle: input.handle,
    name: input.name,
    role: input.role,
    provider: input.provider,
    model: input.model,
  });
}
