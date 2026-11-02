import { describe, expect, it } from 'vitest';

import {
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type ModelRequest,
  type ProviderEvent,
} from '@runnets/provider-core';

import { DEEPSEEK_MODELS, DeepSeekProvider, type DeepSeekProviderOptions } from './provider.js';

const MODEL = 'deepseek-flash';

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

const textDelta = (text: string): string =>
  frame({ choices: [{ delta: { content: text }, finish_reason: null }] });
const finish = (reason: string): string =>
  frame({ choices: [{ delta: {}, finish_reason: reason }] });
const DONE = 'data: [DONE]\n\n';

function makeProvider(
  http: HttpClient,
  options: Partial<DeepSeekProviderOptions> = {},
): DeepSeekProvider {
  return new DeepSeekProvider({ apiKey: 'sk-test-secret', httpClient: http, ...options });
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

function errorOf(events: readonly ProviderEvent[]): { code: string; message: string } {
  const last = events.at(-1);
  if (last?.type !== 'error') throw new Error(`expected a terminal error, got ${last?.type}`);
  return last.error;
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

describe('DeepSeekProvider failures', () => {
  const statuses: ReadonlyArray<[number, string, boolean]> = [
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [400, 'invalid_request', false],
    [422, 'invalid_request', false],
    [500, 'server', true],
    [503, 'server', true],
  ];

  it.each(statuses)('maps HTTP %i to %s', async (status, code, retryable) => {
    const http = fakeHttp({ status, body: '{"error":{"message":"upstream says no"}}' });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), request());

    expect(terminal(events)).toHaveLength(1);
    const error = errorOf(events);
    expect(error.code).toBe(code);
    expect(error.message).toContain('upstream says no');
    expect(error.message).not.toContain('sk-test-secret');
    expect(terminal(events)[0]).toMatchObject({ type: 'error' });
    const terminalEvent = events.at(-1);
    if (terminalEvent?.type === 'error') {
      expect(terminalEvent.error.retryable).toBe(retryable);
      expect(terminalEvent.error.status).toBe(status);
    }
  });

  it('classifies an authentication error delivered inside the stream', async () => {
    const http = fakeHttp({
      chunks: [frame({ error: { message: 'Authentication Fails', type: 'authentication_error' } })],
    });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), request());

    expect(errorOf(events)).toMatchObject({ code: 'auth' });
    const terminalEvent = events.at(-1);
    if (terminalEvent?.type === 'error') expect(terminalEvent.error.retryable).toBe(false);
  });

  it('maps a transport rejection to a retryable network error', async () => {
    const http = fakeHttp({ failWith: new TypeError('fetch failed') });
    const events = await streamEvents(makeProvider(http, { timeoutMs: 0 }), request());

    expect(errorOf(events)).toMatchObject({ code: 'network' });
    const terminalEvent = events.at(-1);
    if (terminalEvent?.type === 'error') expect(terminalEvent.error.retryable).toBe(true);
  });

  it('does not dispatch when the caller signal is already aborted', async () => {
    const http = fakeHttp({ chunks: [textDelta('x'), finish('stop'), DONE] });
    const events = await streamEvents(
      makeProvider(http, { timeoutMs: 0 }),
      request({ signal: AbortSignal.abort() }),
    );

    expect(errorOf(events).code).toBe('cancelled');
    expect(http.calls).toHaveLength(0);
  });

  it('aborts a live stream and reports cancellation after partial output', async () => {
    const controller = new AbortController();
    const http = fakeHttp({
      chunks: [textDelta('partial'), textDelta('never')],
      onChunk: (index) => {
        if (index === 1) controller.abort();
      },
    });
    const events = await streamEvents(
      makeProvider(http, { timeoutMs: 0 }),
      request({ signal: controller.signal }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'partial' });
    expect(errorOf(events).code).toBe('cancelled');
    expect(terminal(events)).toHaveLength(1);
  });
});

describe('DeepSeekProvider metadata', () => {
  it('advertises the deepseek provider, models and capabilities', () => {
    const target = new DeepSeekProvider({ apiKey: 'sk-test-secret' });
    expect(target.id).toBe('deepseek');
    expect(target.models).toEqual(DEEPSEEK_MODELS);
    expect(target.models).toContain('deepseek-flash');
    expect(target.capabilities).toEqual({
      streaming: true,
      reasoning: true,
      usage: true,
      toolCalls: true,
    });
  });

  it('accepts a host-configured model list', () => {
    const target = new DeepSeekProvider({ apiKey: 'sk-test-secret', models: ['custom-model'] });
    expect(target.models).toEqual(['custom-model']);
  });
});
