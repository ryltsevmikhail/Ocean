import { describe, expect, it } from 'vitest';

import {
  ProviderError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ModelRequest,
  type ProviderEvent,
} from '@runnets/provider-core';

import { DeepSeekProvider, type DeepSeekProviderOptions } from './provider.js';

interface FakeScript {
  readonly status?: number;
  readonly chunks?: readonly string[];
  readonly body?: string;
  readonly failWith?: unknown;
  readonly onChunk?: (index: number) => void;
}

interface FakeHttp extends HttpClient {
  readonly calls: HttpRequest[];
}

function fakeHttp(...scripts: readonly FakeScript[]): FakeHttp {
  const calls: HttpRequest[] = [];
  let next = 0;

  return {
    calls,
    async send(request: HttpRequest): Promise<HttpResponse> {
      calls.push(request);
      const position = Math.min(next, Math.max(scripts.length - 1, 0));
      const script = scripts[position] ?? {};
      next += 1;
      if (script.failWith !== undefined) throw script.failWith;
      const status = script.status ?? 200;
      const chunks = script.chunks ?? [];
      return {
        status,
        ok: status < 400,
        text: async () => script.body ?? chunks.join(''),
        stream: () =>
          (async function* () {
            for (const [index, chunk] of chunks.entries()) {
              script.onChunk?.(index);
              if (request.signal?.aborted === true) {
                throw new DOMException('The operation was aborted', 'AbortError');
              }
              yield chunk;
            }
          })(),
      };
    },
  };
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textDelta(text: string): string {
  return frame({ choices: [{ delta: { content: text }, finish_reason: null }] });
}

function reasoningDelta(text: string): string {
  return frame({ choices: [{ delta: { reasoning_content: text } }] });
}

function finish(reason: string): string {
  return frame({ choices: [{ delta: {}, finish_reason: reason }] });
}

function usageFrame(prompt: number, completion: number, total: number): string {
  return frame({
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  });
}

const DONE = 'data: [DONE]\n\n';

function makeProvider(
  http: HttpClient,
  options: Partial<DeepSeekProviderOptions> = {},
): DeepSeekProvider {
  return new DeepSeekProvider({ apiKey: 'sk-test-secret', httpClient: http, ...options });
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

async function streamEvents(
  target: DeepSeekProvider,
  request: ModelRequest,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of target.stream(request)) events.push(event);
  return events;
}

function terminal(events: readonly ProviderEvent[]): ProviderEvent[] {
  return events.filter((event) => event.type === 'completed' || event.type === 'error');
}

function errorOf(events: readonly ProviderEvent[]): ProviderError {
  const last = events.at(-1);
  if (last?.type !== 'error') throw new Error(`expected a terminal error, got ${last?.type}`);
  return last.error;
}

describe('DeepSeekProvider request', () => {
  it('sends an authenticated streaming chat completions request', async () => {
    const http = fakeHttp({ chunks: [textDelta('x'), finish('stop'), DONE] });
    await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    const call = http.calls[0];
    expect(call?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(call?.headers['authorization']).toBe('Bearer sk-test-secret');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['accept']).toBe('text/event-stream');
    expect(call?.signal).toBeUndefined();

    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
    expect(body['model']).toBe('deepseek-flash');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('forwards optional sampling parameters', async () => {
    const http = fakeHttp({ chunks: [textDelta('x'), finish('stop'), DONE] });
    await streamEvents(
      makeProvider(http, { timeoutMs: 0 }),
      makeRequest({ maxTokens: 128, temperature: 0.2 }),
    );

    const body = JSON.parse(http.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['max_tokens']).toBe(128);
    expect(body['temperature']).toBe(0.2);
  });

  it('applies a request deadline by default and joins it with the caller signal', async () => {
    const http = fakeHttp({ chunks: [textDelta('x'), finish('stop'), DONE] });
    const controller = new AbortController();
    await streamEvents(makeProvider(http), makeRequest({ signal: controller.signal }));

    expect(http.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a custom base url and strips a trailing slash', async () => {
    const http = fakeHttp({ chunks: [textDelta('x'), finish('stop'), DONE] });
    await streamEvents(
      makeProvider(http, { baseUrl: 'https://proxy.test/ds/', timeoutMs: 0 }),
      makeRequest(),
    );

    expect(http.calls[0]?.url).toBe('https://proxy.test/ds/chat/completions');
  });

  it('rejects an empty api key before any request', () => {
    expect(() => new DeepSeekProvider({ apiKey: '   ' })).toThrow(ProviderError);
  });
});

describe('DeepSeekProvider stream', () => {
  it('streams text deltas and completes with the vendor stop reason', async () => {
    const http = fakeHttp({ chunks: [textDelta('Hel'), textDelta('lo'), finish('stop'), DONE] });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
      { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
    ]);
  });

  it('maps reasoning content before the answer and continues after a partial frame', async () => {
    const http = fakeHttp({
      chunks: [reasoningDelta('think'), textDelta('answer'), finish('length'), DONE],
    });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events[0]).toEqual({ type: 'reasoning_delta', text: 'think' });
    expect(events[1]).toEqual({ type: 'text_delta', text: 'answer' });
    expect(events.at(-1)).toEqual({
      type: 'completed',
      stopReason: 'length',
      rawStopReason: 'length',
    });
  });

  it('emits usage before the completed event', async () => {
    const http = fakeHttp({
      chunks: [textDelta('a'), usageFrame(7, 3, 10), finish('stop'), DONE],
    });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(events.at(-1)).toEqual({
      type: 'completed',
      stopReason: 'stop',
      rawStopReason: 'stop',
    });
    expect(terminal(events)).toHaveLength(1);
  });

  it('omits usage when the provider never sends it', async () => {
    const http = fakeHttp({ chunks: [textDelta('a'), finish('stop'), DONE] });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(terminal(events)).toHaveLength(1);
  });

  it('treats [DONE] as a terminator and ignores trailing frames', async () => {
    const http = fakeHttp({
      chunks: [textDelta('a'), finish('stop'), DONE, textDelta('after'), finish('length')],
    });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
      { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
    ]);
  });

  it('preserves an unknown finish reason instead of guessing a stop', async () => {
    const http = fakeHttp({
      chunks: [textDelta('partial'), finish('insufficient_system_resource'), DONE],
    });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(events.at(-1)).toEqual({
      type: 'completed',
      stopReason: 'unknown',
      rawStopReason: 'insufficient_system_resource',
    });
  });

  it('bounds a long raw finish reason', async () => {
    const http = fakeHttp({ chunks: [finish('x'.repeat(200)), DONE] });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    const last = events.at(-1);
    expect(last?.type).toBe('completed');
    if (last?.type !== 'completed') return;
    expect(last.stopReason).toBe('unknown');
    expect(last.rawStopReason).toHaveLength(64);
  });

  it('reports a malformed frame as a non-retryable stream error', async () => {
    const http = fakeHttp({ chunks: ['data: {oops\n\n'] });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(errorOf(events)).toMatchObject({
      code: 'server',
      retryable: false,
      message: 'malformed DeepSeek stream event',
    });
    expect(terminal(events)).toHaveLength(1);
  });

  it('reports an empty stream as a stream error', async () => {
    const http = fakeHttp({ chunks: [] });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), makeRequest());

    expect(errorOf(events).message).toBe('empty DeepSeek stream');
    expect(terminal(events)).toHaveLength(1);
  });
});
