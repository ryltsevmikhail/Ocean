import { expect, it } from 'vitest';
import { probeAnthropicModels } from './index.js';
import { fake } from '../test-fixtures/http.js';
import type { HttpClient } from '@runnets/provider-core';
const signal = () => new AbortController().signal;
it('retrieves exactly the supported model with version/auth and bounded GET without inference', async () => {
  const f = fake(['{"id":"claude-haiku-5-5","type":"model"}']);
  expect(
    await probeAnthropicModels({ apiKey: 'fixture-key', httpClient: f.http }, signal()),
  ).toEqual({ outcome: 'ok', httpStatus: 200, models: ['claude-haiku-5-5'] });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    method: 'GET',
    url: 'https://api.anthropic.com/v1/models/claude-haiku-5-5',
    redirect: 'manual',
    headers: { 'x-api-key': 'fixture-key', 'anthropic-version': '2026-10-21' },
  });
  expect(f.calls[0]?.body).toBeUndefined();
});
it.each([400, 401, 403, 404, 429, 500, 308])(
  'sanitizes probe status %s without false auth for workspace refusal',
  async (status) => {
    const f = fake(['private error body'], status);
    expect(await probeAnthropicModels({ apiKey: 'key', httpClient: f.http }, signal())).toEqual({
      outcome: status === 401 || status === 403 ? 'auth' : status >= 500 ? 'server' : 'unavailable',
      httpStatus: status,
      models: [],
    });
    expect(f.calls).toHaveLength(1);
  },
);
it.each(['{}', '{', '{"id":"other"}', '{"data":[{"id":"claude-haiku-5-5"}]}', 'x'.repeat(262145)])(
  'refuses malformed, mismatched and oversized model response %#',
  async (body) => {
    const f = fake([body]);
    expect(await probeAnthropicModels({ apiKey: 'key', httpClient: f.http }, signal())).toEqual({
      outcome: 'server',
      httpStatus: 200,
      models: [],
    });
  },
);
it('pre-aborted probe does not send', async () => {
  const f = fake();
  expect(
    await probeAnthropicModels({ apiKey: 'key', httpClient: f.http }, AbortSignal.abort()),
  ).toEqual({ outcome: 'cancelled', httpStatus: null, models: [] });
  expect(f.calls).toHaveLength(0);
});
it('missing key does not send or discover a workspace', async () => {
  const f = fake();
  expect(await probeAnthropicModels({ apiKey: ' ', httpClient: f.http }, signal())).toEqual({
    outcome: 'unavailable',
    httpStatus: null,
    models: [],
  });
  expect(f.calls).toHaveLength(0);
});
it.each(['send', 'body'])('bounds stalled probe %s by deadline', async (phase) => {
  const httpClient: HttpClient = {
    async send() {
      if (phase === 'send') return new Promise(() => {});
      return {
        status: 200,
        ok: true,
        text: async () => '',
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
      };
    },
  };
  expect(await probeAnthropicModels({ apiKey: 'key', httpClient, timeoutMs: 5 }, signal())).toEqual(
    { outcome: 'timeout', httpStatus: phase === 'send' ? null : 200, models: [] },
  );
});
