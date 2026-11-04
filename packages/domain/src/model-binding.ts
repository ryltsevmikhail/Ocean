import { DomainError } from './errors.js';
import type { Bot } from './conversations.js';

/** A bot chooses its own model; a connection default never rewrites this binding. */
export interface BotModelBinding {
  readonly connectionId: string;
  readonly modelId: string;
}
/** New APIs join current profile and binding without changing historical Bot JSON. */
export interface BoundBot {
  readonly bot: Bot;
  readonly binding: BotModelBinding;
}

/** Strict optional durable authority; absence is handled by historical readers. */
export function copyBotModelBinding(value: unknown): BotModelBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw DomainError.invalidArgument('invalid model binding');
  const data = value as Record<string, unknown>;
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && !v.includes('\0');
  if (!text(data.connectionId) || !text(data.modelId))
    throw DomainError.invalidArgument('invalid model binding');
  return { connectionId: data.connectionId, modelId: data.modelId };
}
