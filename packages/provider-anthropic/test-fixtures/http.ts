import type { HttpClient, HttpRequest, ModelRequest, ProviderEvent } from '@runnets/provider-core';
export const model = 'claude-haiku-5-5';
export const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});
export const frame = (type: string, fields: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
export const prefixUsage = {
  input_tokens: 100,
  cache_creation_input_tokens: 20,
  cache_read_input_tokens: 80,
  output_tokens: 1,
  cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 },
};
export const start = (usage: unknown = prefixUsage) =>
  frame('message_start', {
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
export const delta = (reason: unknown = 'end_turn', usage: unknown = { output_tokens: 7 }) =>
  frame('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage });
export const stop = frame('message_stop');
export const text = [
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
  frame('content_block_stop', { index: 0 }),
];
export const tool = (index = 0, id = 'call_1', args = '{"path":"a"}') => [
  frame('content_block_start', {
    index,
    content_block: { type: 'tool_use', id, name: 'read_file', input: {} },
  }),
  frame('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args } }),
  frame('content_block_stop', { index }),
];
export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
export function fake(chunks: readonly string[] = [start(), ...text, delta(), stop], status = 200) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    async send(r) {
      calls.push(r);
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => {
          throw Error('unbounded reader');
        },
        async *stream() {
          for (const chunk of chunks) yield chunk;
        },
      };
    },
  };
  return { http, calls };
}
export const terminals = (events: readonly ProviderEvent[]) =>
  events.filter((e) => e.type === 'completed' || e.type === 'error');
