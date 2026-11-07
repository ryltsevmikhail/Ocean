import {
  ProviderError,
  validateTokenUsage,
  type ChatContent,
  type ChatMessage,
  type ModelRequest,
  type TokenUsage,
} from '@runnets/provider-core';
import { OPENAI_MODELS } from './profile.js';

/** Narrow an unknown JSON value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Fail closed instead of silently dropping a part the vendor may not accept. */
class WireContentError extends ProviderError {
  constructor(message: string) {
    super('invalid_request', message, { retryable: false, dispatch: 'not_sent' });
  }
}
/**
 * Image parts are legal only in user messages. A data URL is built from the
 * runtime-verified sniffed media type and the exact bytes; no marker text,
 * filename, caption or host path is used as a substitute.
 */
function wireContent(message: ChatMessage): string | readonly unknown[] {
  const content: ChatContent = message.content;
  if (typeof content === 'string') return content;
  if (message.role !== 'user' && content.some((part) => part.type === 'image'))
    throw new WireContentError('image content is only allowed in user messages');
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: {
            url: `data:${part.mediaType};base64,${Buffer.from(part.bytes).toString('base64')}`,
          },
        },
  );
}
/** Build the streaming request body; `stream_options` requests whole-request usage. */
export function buildRequestBody(request: ModelRequest): string {
  if (!(OPENAI_MODELS as readonly string[]).includes(request.model))
    throw new WireContentError('unsupported OpenAI model');
  const maxTokens = request.maxTokens === undefined ? 4096 : request.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000)
    throw new WireContentError('invalid completion token limit');
  const body = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: wireContent(message),

      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
    })),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: tool,
          })),
        }),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: maxTokens,
    store: false,
  };
  return JSON.stringify(body);
}

/** One serializer: the application pre-check and the adapter hard gate share it. */
export function serializedBodyBytes(request: ModelRequest): number {
  return Buffer.byteLength(buildRequestBody(request), 'utf8');
}
export { WireContentError };

/** Read token usage from a chunk; null when the field is absent or unusable. */
export function readUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  return validateTokenUsage({
    inputTokens: record['prompt_tokens'],
    outputTokens: record['completion_tokens'],
    totalTokens: record['total_tokens'],
  });
}
