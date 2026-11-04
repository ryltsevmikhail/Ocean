import {
  ProviderError,
  isImageMediaType,
  type ChatMessage,
  type ModelRequest,
} from '@runnets/provider-core';
import { ANTHROPIC_MODELS } from './profile.js';
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function invalidRequest(): ProviderError {
  return new ProviderError('invalid_request', 'unsupported or malformed Anthropic request', {
    dispatch: 'not_sent',
    retryable: false,
  });
}
export function objectArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidRequest();
  }
  const object = asRecord(parsed);
  if (object === null) throw invalidRequest();
  return object;
}
export function validToolIdentity(id: string, name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}
function content(message: ChatMessage): Record<string, unknown>[] {
  if (typeof message.content === 'string')
    return message.content === '' ? [] : [{ type: 'text', text: message.content }];
  return message.content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type !== 'image' || message.role !== 'user' || !isImageMediaType(part.mediaType))
      throw invalidRequest();
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: Buffer.from(part.bytes).toString('base64'),
      },
    };
  });
}
/** Native history integrity only; schema, authority and execution remain Ocean-owned. */
function history(messages: readonly ChatMessage[]) {
  const system: Record<string, unknown>[] = [];
  const turns: { role: 'assistant' | 'user'; content: Record<string, unknown>[] }[] = [];
  const seen = new Set<string>(),
    pending = new Set<string>();
  for (const message of messages) {
    if (
      (message.reasoning !== undefined && message.reasoning !== '') ||
      (message.toolCalls !== undefined && message.role !== 'assistant') ||
      (message.toolCallId !== undefined && message.role !== 'tool')
    )
      throw invalidRequest();
    if (pending.size > 0 && message.role !== 'tool') throw invalidRequest();
    if (message.role === 'system') {
      if (turns.length > 0) throw invalidRequest();
      system.push(...content(message));
    } else if (message.role === 'tool') {
      const id = message.toolCallId;
      if (id === undefined || !pending.delete(id) || typeof message.content !== 'string')
        throw invalidRequest();
      const result = { type: 'tool_result', tool_use_id: id, content: message.content };
      const previous = turns.at(-1);
      if (previous?.role === 'user' && previous.content[0]?.['type'] === 'tool_result')
        previous.content.push(result);
      else turns.push({ role: 'user', content: [result] });
    } else {
      const blocks = content(message);
      for (const call of message.toolCalls ?? []) {
        if (!validToolIdentity(call.id, call.name) || seen.has(call.id)) throw invalidRequest();
        seen.add(call.id);
        pending.add(call.id);
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: objectArguments(call.arguments),
        });
      }
      turns.push({ role: message.role, content: blocks });
    }
  }
  if (pending.size > 0) throw invalidRequest();
  return { system, messages: turns };
}
/** One serializer serves the runtime byte pre-check and the dispatch hard limit. */
export function buildRequestBody(request: ModelRequest): string {
  const maxTokens = request.maxTokens ?? 4096;
  if (
    !(ANTHROPIC_MODELS as readonly string[]).includes(request.model) ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 128000
  )
    throw invalidRequest();
  const native = history(request.messages);
  return JSON.stringify({
    model: request.model,
    max_tokens: maxTokens,
    stream: true,
    thinking: { type: 'disabled' },
    output_config: { effort: 'medium' },
    ...(native.system.length === 0 ? {} : { system: native.system }),
    messages: native.messages,
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }),
  });
}
export function serializedBodyBytes(request: ModelRequest): number {
  return Buffer.byteLength(buildRequestBody(request), 'utf8');
}
