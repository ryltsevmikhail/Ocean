/**
 * Deterministic provider for the granted-tool host tests.
 *
 * It records every model request, asks for one plugin tool when the request
 * carries tool definitions and the last message is not a tool result, then
 * answers with the bounded tool result text. No network and no real model.
 */
import type {
  ModelRequest,
  ProviderEvent,
  ProviderPort,
  TokenUsage,
} from '../../../packages/application/src/provider.js';

export interface RecordedRequest {
  readonly model: string;
  readonly tools: readonly string[];
  readonly messages: readonly { role: string; content: string }[];
}

export interface DeterministicProvider extends ProviderPort {
  readonly requests: RecordedRequest[];
}

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '[image]',
      )
      .join(' ');
  return '';
}

export function deterministicPluginProvider(input: {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly answer: string;
}): DeterministicProvider {
  const requests: RecordedRequest[] = [];
  let callId = 0;
  const provider: DeterministicProvider = {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    requests,
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      requests.push({
        model: request.model,
        tools: (request.tools ?? []).map((tool) => tool.name),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: textOf(message.content),
        })),
      });
      const last = request.messages[request.messages.length - 1];
      if (last?.role === 'tool') {
        yield { type: 'text_delta', text: input.answer };
        yield { type: 'usage', usage };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        return;
      }
      if (request.tools !== undefined && request.tools.length > 0) {
        callId += 1;
        yield {
          type: 'tool_call',
          call: {
            id: 'provider_call_' + String(callId),
            name: input.tool,
            arguments: JSON.stringify(input.arguments),
          },
        };
        yield { type: 'usage', usage };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
        return;
      }
      yield { type: 'text_delta', text: input.answer };
      yield { type: 'usage', usage };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  return provider;
}
