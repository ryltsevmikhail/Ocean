import type { HttpClient, HttpRequest, ModelRequest, ProviderEvent } from '@runnets/provider-core';
export const model = 'gpt-5.6-terra';
export const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});
export const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
export const choice = (delta: unknown = {}, finish: string | null = null): string =>
  frame({ model, choices: [{ index: 0, delta, finish_reason: finish }] });
export const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
export const usageFrame = frame({ model, choices: [], usage });
export const DONE = 'data: [DONE]\n\n';
export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
export function fake(
  chunks: readonly string[] = [choice({}, 'stop'), usageFrame, DONE],
  status = 200,
) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    async send(r) {
      calls.push(r);
      return {
        status,
        ok: status < 400,
        text: async () => {
          throw Error('unbounded text reader');
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
