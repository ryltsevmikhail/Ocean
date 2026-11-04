import { expect, it } from 'vitest';
import { createFetchHttpClient, collectReply } from '@runnets/provider-core';
import { createDeepSeekProvider, probeDeepSeekModels } from '@runnets/provider-deepseek';
import { createLocalProvider, checkLocalModel } from '@runnets/provider-local';
import { endpoint, qualification, version, tags, show, request } from '../test-fixtures/http.js';
const statuses = [300, 301, 302, 303, 304, 305, 306, 307, 308, 399];
for (const status of statuses) {
  it(`refuses local metadata redirect ${status} at fetch without credential forwarding`, async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createFetchHttpClient(async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status, headers: { Location: 'https://cloud.invalid/chat' } });
    });
    await expect(
      checkLocalModel(
        { endpoint, auth: { mode: 'api_key', key: 'fixture' }, httpClient: http },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ dispatch: 'not_sent', status });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: endpoint + '/api/version',
      init: { redirect: 'manual', headers: { authorization: 'Bearer fixture' } },
    });
  });
  it(`keeps redirected local inference ${status} unknown after one POST`, async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createFetchHttpClient(async (url, init) => {
      seen.push({ url, init });
      const path = new URL(url).pathname;
      const body = (
        { '/api/version': version, '/api/tags': tags, '/api/show': show } as Record<string, unknown>
      )[path];
      return body
        ? Response.json(body)
        : new Response(null, { status, headers: { Location: 'https://cloud.invalid/chat' } });
    });
    const p = createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification,
      httpClient: http,
    });
    expect((await collectReply(p.stream(request))).error).toMatchObject({
      dispatch: 'unknown',
      status,
    });
    expect(seen).toHaveLength(4);
    expect(seen.every((r) => r.init.redirect === 'manual')).toBe(true);
    expect(seen.every((r) => new URL(r.url).origin === endpoint)).toBe(true);
    expect(seen.every((r) => !('authorization' in (r.init.headers ?? {})))).toBe(true);
  });
  it(`refuses DeepSeek inference and probe redirect ${status} at the configured fetch origin`, async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createFetchHttpClient(async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status, headers: { Location: 'https://other.invalid' } });
    });
    const p = createDeepSeekProvider({
      apiKey: 'fixture',
      baseUrl: 'https://direct.invalid/v1',
      httpClient: http,
    });
    const reply = await collectReply(p.stream({ model: 'deepseek-flash', messages: [] }));
    expect(reply.error).toMatchObject({ dispatch: 'unknown', status });
    expect(
      (
        await probeDeepSeekModels({
          apiKey: 'fixture',
          baseUrl: 'https://direct.invalid/v1',
          httpClient: http,
        })
      ).outcome,
    ).not.toBe('ok');
    expect(seen.map((r) => [r.url, r.init.redirect])).toEqual([
      ['https://direct.invalid/v1/chat/completions', 'manual'],
      ['https://direct.invalid/v1/models', 'manual'],
    ]);
  });
}
it('fatal UTF-8 refuses malformed native bytes rather than replacing them into JSON', async () => {
  const http = createFetchHttpClient(
    async () => new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])),
  );
  const response = await http.send({ url: endpoint, headers: {} });
  await expect(
    (async () => {
      for await (const _part of response.stream()) {
        /* decode */
      }
    })(),
  ).rejects.toThrow();
});
