/**
 * DeepSeek chat-completions wire format.
 *
 * The adapter speaks the OpenAI-compatible streaming chat completions API.
 * Everything here works on untrusted JSON: unknown in, normalized fields out,
 * so a vendor shape change fails as a typed error instead of a crash.
 */

import {
  validateTokenUsage,
  type ChatContent,
  type ChatMessage,
  type ModelRequest,
  type TokenUsage,
} from '@runnets/provider-core';

export const DEEPSEEK_DEFAULT_ORIGIN = 'https://api.deepseek.com';
export const DEEPSEEK_CHAT_PATH = '/chat/completions';
/** Metadata-only model discovery used by an explicit owner connection check. */
export const DEEPSEEK_MODELS_PATH = '/models';

export interface StreamDelta {
  readonly content: string | null;
  readonly reasoning: string | null;
  readonly finishReason: string | null;
}

/** Narrow an unknown JSON value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Fail closed instead of silently dropping a part the vendor may not accept. */
class WireContentError extends Error {}
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
/** Build the streaming request body; `stream_options` makes DeepSeek emit usage. */
export function buildRequestBody(request: ModelRequest): string {
  const body = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: wireContent(message),
      ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
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
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
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

/** Read one streamed choice delta, or null when the chunk carries no choice. */
export function readDelta(record: Record<string, unknown>): StreamDelta | null {
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = asRecord(choices[0]);
  if (choice === null) return null;
  const delta = asRecord(choice['delta']);
  return {
    content: delta === null ? null : readText(delta['content']),
    reasoning: delta === null ? null : readText(delta['reasoning_content']),
    finishReason: readText(choice['finish_reason']),
  };
}
