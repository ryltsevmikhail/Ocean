/**
 * In-memory conversation context.
 *
 * The provider contract is a flat message list, so the host keeps prior user
 * and assistant turns to give a prompt its history. Conversation state is
 * process-local; a durable conversation aggregate is not implemented yet.
 */

import type { ContentBlock } from '@runnets/contracts';
import type { ChatMessage } from '@runnets/provider-core';

export class Conversation {
  readonly #messages: ChatMessage[] = [];

  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  /** Retain complete assistant/tool exchanges, including reasoning needed by DeepSeek. */
  appendMessages(messages: readonly ChatMessage[]): void {
    this.#messages.push(...messages);
  }

  appendUser(text: string): void {
    this.#messages.push({ role: 'user', content: text });
  }

  appendAssistant(text: string): void {
    if (text.trim() === '') return;
    this.#messages.push({ role: 'assistant', content: text });
  }
}

/** Extract the text of an ACP prompt; non-text blocks are not supported yet. */
export function textOfPrompt(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
