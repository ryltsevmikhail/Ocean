import {
  REQUEST_HARD_LIMIT_BYTES,
  type ChatMessage,
  type ModelRequest,
} from '@runnets/provider-core';
import { MODEL, object, refuse, type LocalAuth } from './profile.js';
export type { LocalAuth };
function content(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  let text = '';
  for (const part of message.content) {
    if (part.type !== 'text') refuse('local vision unavailable');
    text += part.text;
  }
  return text;
}
/** IDs remain Ocean authority; the native initial profile correlates a unique name per round. */
export function buildRequestBody(request: ModelRequest, tools = true): string {
  if (
    !tools &&
    (request.tools !== undefined ||
      request.messages.some((m) => m.role === 'tool' || m.toolCalls !== undefined))
  )
    refuse('text-only local tools unavailable');
  if (request.model !== MODEL) refuse('unsupported local model');
  const max = request.maxTokens ?? 512;
  if (!Number.isSafeInteger(max) || max < 1 || max > 512) refuse('invalid local output bound');
  const messages: Record<string, unknown>[] = [];
  let pending = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const m of request.messages) {
    if (m.reasoning !== undefined && m.reasoning !== '') refuse('local thinking unsupported');
    if (m.role === 'tool') {
      const name = pending.get(m.toolCallId ?? '');
      if (!name || m.toolCalls?.length) refuse('unmatched local tool result');
      pending.delete(m.toolCallId!);
      messages.push({ role: 'tool', tool_name: name, content: content(m) });
      continue;
    }
    if (pending.size > 0) refuse('missing local tool result');
    const wire: Record<string, unknown> = { role: m.role, content: content(m) };
    if (m.toolCalls?.length) {
      if (m.role !== 'assistant') refuse('invalid local tool role');
      const names = new Set<string>();
      pending = new Map();
      wire['tool_calls'] = m.toolCalls.map((call) => {
        if (
          !call.id ||
          usedIds.has(call.id) ||
          !call.name ||
          call.name.length > 128 ||
          names.has(call.name)
        )
          refuse('ambiguous local tool correlation');
        let args: Record<string, unknown> | null;
        try {
          args = object(JSON.parse(call.arguments) as unknown);
        } catch {
          refuse('invalid local tool arguments');
        }
        if (!args) refuse('invalid local tool arguments');
        names.add(call.name);
        usedIds.add(call.id);
        pending.set(call.id, call.name);
        return { function: { name: call.name, arguments: args } };
      });
    }
    messages.push(wire);
  }
  if (pending.size > 0) refuse('missing local tool result');
  const body = JSON.stringify({
    model: MODEL,
    messages,
    stream: true,
    think: false,
    options: { num_ctx: 4096, num_predict: max },
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  });
  if (Buffer.byteLength(body, 'utf8') > REQUEST_HARD_LIMIT_BYTES) refuse('request_too_large');
  return body;
}
