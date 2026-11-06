import { expect, it } from 'vitest';
import { connection } from '../test-fixtures/admission.js';
import { createMcpServiceTransport } from './index.js';
import { httpFixture, definition } from './prototype-http-fixture.js';

const escaped = 'abc"de\\f',
  numeric = '724938162573';
it.each([
  ['catalog value', escaped],
  ['catalog key', escaped],
  ['quoted result', escaped],
  ['numeric catalog default', numeric],
  ['numeric result', numeric],
] as const)('withholds a synthetic bearer in the %s', async (mode, secret) => {
  const catalog = mode.includes('catalog');
  const f = await httpFixture('echo');
  const t = createMcpServiceTransport({
    protocol: '2026-07-28',
    resolveCredential: () => secret,
  });
  const c = connection({ kind: 'http', url: f.url.href }, 'env:SYNTHETIC');
  try {
    if (catalog) {
      const tool = definition('other');
      if (mode === 'catalog key')
        tool.inputSchema = { type: 'object', properties: { [secret]: { type: 'string' } } };
      if (mode === 'numeric catalog default')
        tool.inputSchema = {
          type: 'object',
          properties: { limit: { type: 'integer', default: Number(secret) } },
        };
      f.extra.push({
        ...tool,
        name: 'other',
        description: mode === 'catalog value' ? 'before ' + secret + ' after' : 'safe',
      });
    }
    const discovery = t.discover(c, {
      authorizeMetadata: () => true,
      deadlineMs: 2000,
      signal: new AbortController().signal,
    });
    if (catalog) {
      await expect(discovery).rejects.toMatchObject({
        code: 'catalog_incomplete',
        message: 'no qualified complete catalog',
      });
    } else {
      const candidate = await discovery,
        s = { ...candidate, id: 'test' };
      expect(t.activate(candidate, s, () => true)).toBe(true);
      const outcome = await t.invoke({
        connection: { ...c, currentCatalogId: s.id },
        catalogId: s.id,
        definition: s.tools[0]!,
        arguments: { value: 'alpha', echo: mode === 'numeric result' ? Number(secret) : secret },
        invocationId: 'echo',
        authorizeDispatch: () => true,
        deadlineMs: 1000,
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({
        kind: 'uncertain',
        detail: 'no valid response after dispatch',
      });
      expect([f.stats.calls, f.stats.effects]).toEqual([1, 1]);
    }
  } finally {
    await t.close();
    await f.close();
  }
});
