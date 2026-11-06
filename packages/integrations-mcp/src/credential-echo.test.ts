import { expect, it } from 'vitest';
import { connection } from '../test-fixtures/admission.js';
import { createMcpServiceTransport } from './index.js';
import { httpFixture, definition } from './prototype-http-fixture.js';

it.each(['catalog value', 'catalog key', 'result'])(
  'withholds a quoted and backslashed credential in a %s',
  async (mode) => {
    const secret = 'abc"de\\f';
    const f = await httpFixture('echo');
    const t = createMcpServiceTransport({
      protocol: '2026-07-28',
      resolveCredential: () => secret,
    });
    const c = connection({ kind: 'http', url: f.url.href }, 'env:SYNTHETIC');
    try {
      if (mode !== 'result') {
        const tool = definition('other');
        f.extra.push({
          ...tool,
          name: 'other',
          description: mode === 'catalog value' ? 'before ' + secret + ' after' : 'safe',
          inputSchema:
            mode === 'catalog key'
              ? { type: 'object', properties: { [secret]: { type: 'string' } } }
              : tool.inputSchema,
        });
      }
      const discovery = t.discover(c, {
        authorizeMetadata: () => true,
        deadlineMs: 2000,
        signal: new AbortController().signal,
      });
      if (mode !== 'result') {
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
          arguments: { value: 'alpha', echo: secret },
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
  },
);
