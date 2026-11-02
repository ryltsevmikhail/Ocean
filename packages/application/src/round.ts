import {
  ProviderError,
  type ChatMessage,
  type CompletionStopReason,
  type TokenUsage,
  type ToolCall,
} from './provider.js';
import { emitText } from './lifecycle.js';
import type { TurnInput } from './types.js';

export interface ModelRound {
  readonly text: string;
  readonly reasoning: string;
  readonly calls: readonly ToolCall[];
  readonly usage: TokenUsage | null;
  readonly stop: CompletionStopReason | null;
  readonly failure: ProviderError | null;
}

/** Collect one bounded dispatch; no tool may execute until its usage and terminal are validated. */
export async function modelRound(
  input: TurnInput,
  messages: readonly ChatMessage[],
): Promise<ModelRound> {
  let text = '';
  let reasoning = '';
  let usage: TokenUsage | null = null;
  let stop: CompletionStopReason | null = null;
  let failure: ProviderError | null = null;
  const calls: ToolCall[] = [];
  if (input.provider === null) throw new Error('provider is required');
  try {
    for await (const event of input.provider.stream({
      model: input.model,
      messages: [...messages],
      signal: input.signal,
      ...(input.tools === undefined ? {} : { tools: input.tools.definitions }),
    })) {
      switch (event.type) {
        case 'tool_call':
          calls.push(event.call);
          break;
        case 'text_delta':
          text += event.text;
          emitText(input, 'agent_message_chunk', event.text);
          break;
        case 'reasoning_delta':
          reasoning += event.text;
          emitText(input, 'agent_thought_chunk', event.text);
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'completed':
          stop = event.stopReason;
          break;
        case 'error':
          failure = event.error;
          break;
      }
      if (text.length + reasoning.length > 262144 || calls.length > 32)
        throw new ProviderError('invalid_request', 'model output limit exceeded');
    }
  } catch (error) {
    failure =
      error instanceof ProviderError
        ? error
        : new ProviderError('unknown', 'provider stream failed');
  }
  return { text, reasoning, usage, stop, calls, failure };
}
