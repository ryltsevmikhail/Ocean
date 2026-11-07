import { expect, it, vi, afterEach } from 'vitest';
import { probeDeepSeekModels } from './models.js';
import { createDeepSeekProvider } from './provider.js';
import { collectReply, type HttpClient } from '@runnets/provider-core';
afterEach(() => vi.useRealTimers());
it('reads metadata through a bounded streaming reader', async () => {
  const http: HttpClient = {
    async send() {
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw Error('unbounded');
        },
        async *stream() {
          yield '{"data":[{"id":"deepseek-flash"}]}';
        },
      };
    },
  };
  expect((await probeDeepSeekModels({ apiKey: 'fixture', httpClient: http })).outcome).toBe('ok');
});
it('refuses redirects without reading an untrusted redirect body', async () => {
  const http: HttpClient = {
    async send() {
      return {
        ok: false,
        status: 302,
        text: async () => 'fixture credential or transcript',
        async *stream() {
          yield 'fixture credential or transcript';
        },
      };
    },
  };
  const result = await collectReply(
    createDeepSeekProvider({ apiKey: 'fixture', httpClient: http }).stream({
      model: 'deepseek-flash',
      messages: [],
    }),
  );
  expect(result.error).toMatchObject({ dispatch: 'unknown', status: 302 });
  expect(result.error?.message).not.toContain('credential or transcript');
});
it('normalizes a NaN metadata timeout rather than throwing a native timer error', async () => {
  const http: HttpClient = {
    async send() {
      return { ok: false, status: 404, text: async () => '', async *stream() {} };
    },
  };
  expect(
    (await probeDeepSeekModels({ apiKey: 'fixture', httpClient: http, timeoutMs: NaN })).outcome,
  ).toBe('unavailable');
});
