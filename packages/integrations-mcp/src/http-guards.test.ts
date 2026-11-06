/** Current wire guards retain the retired producer's product bounds without its SDK. */
import { expect, it, vi } from 'vitest';
import { connection } from '../test-fixtures/admission.js';
import { httpFixture } from './prototype-http-fixture.js';
import { createMcpServiceTransport } from './index.js';
import { serviceHttp } from './http.js';
import { SessionWriter } from './session-writer.js';

it.each([
  'request',
  'wire',
  'response-under',
  'response-over',
  'catalog-under',
  'catalog-over',
  'catalog-aggregate',
] as const)(
  'enforces the current %s byte bound without a second business send',
  async (scenario) => {
    const mode = scenario.split('-')[0]!;
    const over = scenario.endsWith('over') || scenario === 'catalog-aggregate';
    const limit = 4 * 1024 * 1024;
    const paddedSizes: number[] = [];
    const metadata = vi.spyOn(SessionWriter.prototype, 'countMetadata');
    const f = await httpFixture('normal');
    const t = createMcpServiceTransport({ protocol: '2026-07-28' });
    const c = connection({ kind: 'http', url: f.url.href });
    const original = globalThis.fetch;
    const fetches = vi.spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      expect(String(target)).toBe(f.url.href);
      expect(init?.redirect).toBe('error');
      const response = await original(target, init);
      const method = JSON.parse(String(init?.body ?? '{}')).method as string | undefined;
      let size: number | null = null;
      if (
        (mode === 'response' && method === 'tools/call') ||
        (mode === 'catalog' && method === 'tools/list')
      )
        size = over ? limit + 1 : limit - 4096;
      if (scenario === 'catalog-aggregate') {
        if (method === 'server/discover') size = 2048;
        if (method === 'tools/list') size = limit - 1024;
      }
      if (size !== null) {
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const padded = body + ' '.repeat(size - Buffer.byteLength(body));
        expect(JSON.parse(padded)).toEqual(JSON.parse(body));
        expect(Buffer.byteLength(padded)).toBe(size);
        paddedSizes.push(size);
        return new Response(padded, { headers: response.headers, status: response.status });
      }
      return response;
    });
    try {
      const discovering = t.discover(c, {
        signal: new AbortController().signal,
        deadlineMs: 2000,
        authorizeMetadata: () => true,
      });
      if (mode === 'catalog' && over) {
        await expect(discovering).rejects.toMatchObject({ code: 'catalog_incomplete' });
        expect([f.stats.calls, f.stats.effects]).toEqual([0, 0]);
        expect(
          fetches.mock.calls.filter(
            ([, init]) => JSON.parse(String(init?.body ?? '{}')).method === 'tools/call',
          ),
        ).toHaveLength(0);
        expect(metadata.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBeGreaterThan(limit);
      } else {
        const candidate = await discovering,
          snapshot = { ...candidate, id: 'published' };
        expect(t.activate(candidate, snapshot, () => true)).toBe(true);
        if (mode === 'catalog')
          expect(metadata.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBeLessThan(limit);
        const args = {
          value:
            mode === 'request'
              ? 'x'.repeat(1024 * 1024)
              : mode === 'wire'
                ? 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify({ value: '' })) - 1)
                : 'alpha',
        };
        if (mode === 'wire')
          expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(1024 * 1024);
        const prepared = vi.spyOn(SessionWriter.prototype, 'prepare');
        const outcome = await t.invoke({
          connection: { ...c, currentCatalogId: snapshot.id },
          catalogId: snapshot.id,
          definition: snapshot.tools[0]!,
          arguments: args,
          invocationId: 'bounded',
          signal: new AbortController().signal,
          deadlineMs: 2000,
          authorizeDispatch: () => true,
        });
        const preparations = prepared.mock.calls.filter(
          ([method]) => method === 'tools/call',
        ).length;
        prepared.mockRestore();
        const wireCalls = fetches.mock.calls.filter(
          ([, init]) => JSON.parse(String(init?.body ?? '{}')).method === 'tools/call',
        );
        expect(wireCalls).toHaveLength(['request', 'wire'].includes(mode) ? 0 : 1);
        expect(preparations).toBe(['request', 'wire'].includes(mode) ? 0 : 1);
        expect(outcome.kind).toBe(
          ['request', 'wire'].includes(mode)
            ? 'not_started'
            : mode === 'response' && over
              ? 'uncertain'
              : 'observed',
        );
        if (outcome.kind === 'observed') expect(outcome.code).toBe('ok');
        expect([f.stats.calls, f.stats.effects]).toEqual(
          ['request', 'wire'].includes(mode) ? [0, 0] : [1, 1],
        );
      }
      if (mode === 'catalog') {
        expect(f.rows.filter((method) => method === 'tools/list')).toHaveLength(1);
        expect(
          fetches.mock.calls.filter(
            ([, init]) => JSON.parse(String(init?.body ?? '{}')).method === 'tools/list',
          ),
        ).toHaveLength(1);
      }
      if (mode === 'response' || mode === 'catalog')
        expect(paddedSizes).toEqual(
          scenario === 'catalog-aggregate'
            ? [2048, limit - 1024]
            : [over ? limit + 1 : limit - 4096],
        );
    } finally {
      await t.close();
      fetches.mockRestore();
      metadata.mockRestore();
      await f.close();
    }
  },
);
it('refuses insecure credentials and a changed fixed GitHub target before network access', () => {
  const signal = new AbortController().signal;
  const writer = new SessionWriter(
    signal,
    { signal, deadlineMs: 2000, authorizeMetadata: () => true },
    {},
  );
  expect(() => serviceHttp('http://third.example/mcp', 'synthetic', false, writer)).toThrow(
    'insecure credential endpoint',
  );
  expect(() => serviceHttp('https://third.example/mcp', 'synthetic', true, writer)).toThrow(
    'unexpected GitHub endpoint',
  );
  expect(writer.transmitted).toBe(false);
});
