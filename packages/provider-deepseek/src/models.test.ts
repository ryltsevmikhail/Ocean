import { describe, expect, it } from 'vitest';

import type { HttpClient, HttpRequest, HttpResponse } from '@runnets/provider-core';

import { probeDeepSeekModels } from './models.js';

interface FakeHttp extends HttpClient {
  readonly calls: HttpRequest[];
}
function fakeHttp(respond: () => Promise<HttpResponse>): FakeHttp {
  const calls: HttpRequest[] = [];
  return {
    calls,
    send(request) {
      calls.push(request);
      return respond();
    },
  };
}
const reply = (status: number, body: string): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
  stream: async function* () {
    yield body;
  },
});
const API_KEY = 'sk-fixture-model-probe-key';

describe('probeDeepSeekModels', () => {
  it('sends one bounded GET /models with the bearer credential and reads documented metadata', async () => {
    const http = fakeHttp(async () =>
      reply(
        200,
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
            { id: 'deepseek-v4-pro', input_modalities: ['text'] },
          ],
        }),
      ),
    );
    const result = await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      url: 'https://api.deepseek.com/models',
      method: 'GET',
      headers: { authorization: `Bearer ${API_KEY}`, accept: 'application/json' },
    });
    expect(http.calls[0]?.body).toBeUndefined();
    expect(result).toEqual({
      outcome: 'ok',
      httpStatus: 200,
      models: [
        { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4-pro', inputModalities: ['text'] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('reports a rejected credential without vendor text or the key', async () => {
    const http = fakeHttp(async () =>
      reply(401, JSON.stringify({ error: { message: 'bad key' } })),
    );
    const result = await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http });
    expect(result).toEqual({ outcome: 'auth', httpStatus: 401, models: [] });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each([
    [500, 'server'],
    [429, 'unavailable'],
    [404, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, outcome) => {
    const http = fakeHttp(async () => reply(status, '{"error":{"message":"x"}}'));
    expect(await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http })).toEqual({
      outcome,
      httpStatus: status,
      models: [],
    });
  });

  it('fails closed when the body is not a documented model list', async () => {
    for (const body of ['not json', '{}', '{"data":[{"nope":1}]}', '{"data":[{"id":""}]}']) {
      const http = fakeHttp(async () => reply(200, body));
      expect(await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http })).toEqual({
        outcome: 'server',
        httpStatus: 200,
        models: [],
      });
    }
  });

  it('declares only documented modalities and never infers image support', async () => {
    const http = fakeHttp(async () =>
      reply(
        200,
        JSON.stringify({
          data: [{ id: 'deepseek-v4-pro', input_modalities: ['text'] }, { id: 'x' }],
        }),
      ),
    );
    const result = await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http });
    expect(result.outcome).toBe('ok');
    expect(result.models).toEqual([
      { id: 'deepseek-v4-pro', inputModalities: ['text'] },
      { id: 'x', inputModalities: [] },
    ]);
    expect(result.models.every((m) => !m.inputModalities.includes('image'))).toBe(true);
  });

  it('maps transport failures and its own deadline to normalized outcomes', async () => {
    const http = fakeHttp(async () => {
      throw Object.assign(Error('boom'), { name: 'TimeoutError' });
    });
    expect(await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http })).toEqual({
      outcome: 'timeout',
      httpStatus: null,
      models: [],
    });
    const network = fakeHttp(async () => {
      throw Error('socket exploded');
    });
    expect(await probeDeepSeekModels({ apiKey: API_KEY, httpClient: network })).toEqual({
      outcome: 'network',
      httpStatus: null,
      models: [],
    });
  });

  it('clamps the owner deadline to the ten-second maximum', async () => {
    const http = fakeHttp(async () => reply(200, '{"data":[]}'));
    const started = Date.now();
    expect(
      await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http, timeoutMs: 600_000 }),
    ).toEqual({ outcome: 'ok', httpStatus: 200, models: [] });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('honours a caller abort as an incomplete bounded check', async () => {
    const controller = new AbortController();
    controller.abort();
    const http = fakeHttp(async () => reply(200, '{"data":[]}'));
    expect(
      await probeDeepSeekModels({ apiKey: API_KEY, httpClient: http, signal: controller.signal }),
    ).toEqual({ outcome: 'timeout', httpStatus: null, models: [] });
  });
});
