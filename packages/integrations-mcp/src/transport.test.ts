import { SessionWriter } from './session-writer.js';
import { it, expect, vi } from 'vitest';
import { httpFixture } from './prototype-http-fixture.js';
import { createMcpServiceTransport } from './index.js';
import { serviceConnection } from '../../../test-fixtures/service-authority.js';

it.each([
  'drop',
  'redirect',
  '401',
  '403',
  '404',
  'invalid',
  'input',
  'header',
  'protocol',
  'json',
])('admits one SDK attempt without implicit metadata or retries: %s', async (mode) => {
  const f = await httpFixture(mode);
  let attempts = 0;
  const t = createMcpServiceTransport({
    protocol: '2026-07-28',
    resolveCredential: () => 'SYNTHETIC',
    prepareDispatch: () => {
      attempts++;
    },
  });
  const c = { ...serviceConnection, configuration: { kind: 'http' as const, url: f.url.href } };
  try {
    const candidate = await t.discover(c, {
      signal: new AbortController().signal,
      deadlineMs: 2000,
      authorizeMetadata: () => true,
    });
    const snapshot = { ...candidate, id: 'published' };
    let guard = 0;
    const call = () =>
      t.invoke({
        connection: { ...c, currentCatalogId: snapshot.id },
        catalogId: snapshot.id,
        definition: candidate.tools[0]!,
        arguments: { value: 'alpha' },
        signal: new AbortController().signal,
        deadlineMs: 2000,
        invocationId: 'i',
        authorizeDispatch: () => {
          guard++;
          return true;
        },
      });
    expect((await call()).kind).toBe('not_started');
    expect(t.activate(candidate, snapshot, () => false)).toBe(false);
    expect(t.activate({ ...candidate }, snapshot, () => true)).toBe(false);
    expect(t.activate(candidate, snapshot, () => true)).toBe(true);
    const before = f.rows.length;
    const sdk = vi.spyOn(SessionWriter.prototype, 'prepare');
    const outcome = await call();
    expect(outcome.kind).toBe(
      ['drop', 'redirect', 'invalid'].includes(mode) ? 'uncertain' : 'observed',
    );
    expect(sdk.mock.calls.map(([method]) => method)).toEqual(['tools/call']);
    sdk.mockRestore();
    expect(f.rows.slice(before)).toEqual(['tools/call']);
    expect([attempts, guard, f.stats.calls]).toEqual([1, 1, 1]);
  } finally {
    await t.close();
    await f.close();
  }
});

it.each(['duplicate', 'oversized', 'malformed'])(
  'refuses %s metadata instead of publishing a partial catalog',
  async (mode) => {
    const f = await httpFixture('json');
    const original = { name: 'other', inputSchema: { type: 'object' as const } };
    const t = createMcpServiceTransport({ protocol: '2026-07-28' });
    try {
      if (mode === 'duplicate') f.extra.push({ ...original, name: 'write' });
      if (mode === 'malformed')
        f.extra.push({ ...original, inputSchema: { type: 'invalid' as 'object' } });
      if (mode === 'oversized')
        for (let i = 0; i < 256; i++) f.extra.push({ ...original, name: 'tool' + i });
      const c = {
        ...serviceConnection,
        credentialReference: null,
        configuration: { kind: 'http' as const, url: f.url.href },
      };
      await expect(
        t.discover(c, {
          authorizeMetadata: () => true,
          signal: new AbortController().signal,
          deadlineMs: 2000,
        }),
      ).rejects.toMatchObject({ code: 'catalog_incomplete' });
      expect(f.rows).not.toContain('tools/call');
    } finally {
      await t.close();
      await f.close();
    }
  },
);
it('never opens a credential or starts metadata after owner denial', async () => {
  const t = createMcpServiceTransport({
    resolveCredential: () => {
      throw Error('unexpected lookup');
    },
  });
  await expect(
    t.discover(serviceConnection, {
      authorizeMetadata: () => false,
      signal: new AbortController().signal,
      deadlineMs: 2000,
    }),
  ).rejects.toMatchObject({ code: 'catalog_incomplete' });
  expect(await t.close()).toEqual({ status: 'never_started' });
});

it('coalesces list-changed and TTL into a single separately owned refresh hint', async () => {
  const f = await httpFixture('notification');
  let hints = 0;
  const t = createMcpServiceTransport({
    refreshNeeded: () => {
      hints++;
    },
  });
  const c = {
    ...serviceConnection,
    credentialReference: null,
    configuration: { kind: 'http' as const, url: f.url.href },
  };
  try {
    const first = await t.discover(c, {
      authorizeMetadata: () => true,
      deadlineMs: 2000,
      signal: new AbortController().signal,
    });
    const s = { ...first, id: 'change' };
    expect(t.activate(first, s, () => true)).toBe(true);
    const before = f.rows.length;
    const reply = await t.invoke({
      connection: { ...c, currentCatalogId: s.id },
      catalogId: s.id,
      definition: s.tools[0]!,
      arguments: { value: 'alpha' },
      invocationId: 'one',
      signal: new AbortController().signal,
      deadlineMs: 2000,
      authorizeDispatch: () => true,
    });
    expect(reply.kind).toBe('observed');
    await vi.waitFor(() => expect(hints).toBe(1), { timeout: 700 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(hints).toBe(1);
    expect(f.rows.slice(before)).toEqual(['tools/call']);
  } finally {
    await t.close();
    await f.close();
  }
});
