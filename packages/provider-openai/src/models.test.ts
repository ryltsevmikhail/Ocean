import { expect, it } from 'vitest';
import type { HttpClient } from '@runnets/provider-core';
import { probeOpenAIModels } from './index.js';
import { fake } from '../test-fixtures/http.js';
it('probes canonical metadata once with a bounded stream reader and sanitized IDs only', async () => {
  const { http, calls } = fake([
    '{"data":[{"id":"gpt-5.6-terra","untrusted":"ignored"},{"id":"other"}]}',
  ]);
  expect(
    await probeOpenAIModels({ apiKey: 'key', httpClient: http }, new AbortController().signal),
  ).toEqual({ outcome: 'ok', httpStatus: 200, models: ['gpt-5.6-terra', 'other'] });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: 'https://api.openai.com/v1/models',
    method: 'GET',
    headers: { authorization: 'Bearer key' },
  });
  expect(calls[0]!.body).toBeUndefined();
});
it.each([
  'x'.repeat(262145),
  '{broken',
  '{"data":[{"id":""}]}',
  JSON.stringify({ data: Array.from({ length: 201 }, () => ({ id: 'x' })) }),
])('refuses oversized or malformed metadata (%#)', async (body) => {
  const { http, calls } = fake([body]);
  expect(
    await probeOpenAIModels({ apiKey: 'key', httpClient: http }, new AbortController().signal),
  ).toEqual({ outcome: 'server', httpStatus: 200, models: [] });
  expect(calls).toHaveLength(1);
});
it.each([
  [401, 'auth'],
  [429, 'unavailable'],
  [503, 'server'],
])('sanitizes probe status %s', async (status, outcome) => {
  const { http } = fake(['secret'], status as number);
  expect(
    await probeOpenAIModels({ apiKey: 'secret', httpClient: http }, new AbortController().signal),
  ).toEqual({ outcome, httpStatus: status, models: [] });
});
it('does not send a pre-aborted probe', async () => {
  const { http, calls } = fake();
  const abort = new AbortController();
  abort.abort();
  expect(await probeOpenAIModels({ apiKey: 'key', httpClient: http }, abort.signal)).toEqual({
    outcome: 'cancelled',
    httpStatus: null,
    models: [],
  });
  expect(calls).toHaveLength(0);
});
it('keeps a deadline active while reading metadata', async () => {
  const http: HttpClient = {
    async send(r) {
      return {
        status: 200,
        ok: true,
        text: async () => '',
        async *stream() {
          await new Promise<void>((_resolve, reject) =>
            r.signal!.addEventListener('abort', () => reject(r.signal!.reason), { once: true }),
          );
          yield '';
        },
      };
    },
  };
  expect(
    await probeOpenAIModels(
      { apiKey: 'key', httpClient: http, timeoutMs: 5 },
      new AbortController().signal,
    ),
  ).toMatchObject({ outcome: 'timeout', models: [] });
});
