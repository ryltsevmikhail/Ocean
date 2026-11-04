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
