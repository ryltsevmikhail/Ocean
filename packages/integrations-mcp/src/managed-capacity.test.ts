import { expect, it, vi } from 'vitest';
import type { SessionWriter } from './session-writer.js';
import { createMcpServiceTransport } from './index.js';
import { connection } from '../test-fixtures/admission.js';
import { httpFixture } from './prototype-http-fixture.js';
const state = vi.hoisted(() => ({
  url: '',
  starts: 0,
  hold: false,
  enter: () => {},
  wait: Promise.resolve(),
}));
vi.mock('./stdio.js', async () => {
  const { serviceHttp } = await import('./http.js');
  return {
    serviceStdio: async (c: { id: string }, _o: unknown, writer: SessionWriter) => {
      state.starts++;
      return {
        transport: serviceHttp(state.url, null, false, writer),
        managed: null,
        lost() {},
        prepareRetirement: async () => {},
        cleanup: async () => {
          if (c.id === 'c0' && state.hold) {
            state.enter();
            await state.wait;
          }
          return { status: 'confirmed' };
        },
      };
    },
  };
});
it('reuses the retiring same-connection slot at eight without admitting a ninth independent candidate', async () => {
  const fixture = await httpFixture('normal');
  state.url = fixture.url.href;
  state.starts = 0;
  const t = createMcpServiceTransport({});
  const connections = Array.from({ length: 8 }, (_, n) => ({
    ...connection({
      kind: 'stdio',
      executable: '/server.mjs',
      sha256: 'a'.repeat(64),
      args: [],
      workspaceRoot: '/owned/' + n,
    }),
    id: 'c' + n,
  }));
  const discover = (c: (typeof connections)[number]) =>
    t.discover(c, {
      signal: new AbortController().signal,
      deadlineMs: 2000,
      authorizeMetadata: () => true,
    });
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((r) => {
    entered = r;
  });
  state.enter = entered;
  state.wait = new Promise<void>((r) => {
    release = r;
  });
  try {
    for (const c of connections) {
      const candidate = await discover(c);
      const snapshot = { ...candidate, id: 'catalog-' + c.id };
      expect(t.activate(candidate, snapshot, () => true)).toBe(true);
      c.currentCatalogId = snapshot.id;
    }
    expect(state.starts).toBe(8);
    state.hold = true;
    const replacement = discover({ ...connections[0]!, configRevision: 2 }).then(
      (candidate) => ({ candidate }),
      () => null,
    );
    expect(
      await Promise.race([entry.then(() => 'retiring'), replacement.then(() => 'finished')]),
    ).toBe('retiring');
    await expect(discover({ ...connections[0]!, id: 'ninth' })).rejects.toMatchObject({
      code: 'execution_disabled',
    });
    expect(state.starts).toBe(8);
    state.hold = false;
    release();
    const replaced = await replacement;
    expect(replaced).not.toBe(null);
    expect(
      t.activate(replaced!.candidate, { ...replaced!.candidate, id: 'replacement' }, () => true),
    ).toBe(true);
    expect(state.starts).toBe(9);
    await expect(discover({ ...connections[0]!, id: 'ninth' })).rejects.toMatchObject({
      code: 'execution_disabled',
    });
  } finally {
    state.hold = false;
    release();
    await t.close();
    await fixture.close();
  }
});
it('retains the other occupied HTTP sessions readiness while reusing their shared capacity slots', async () => {
  const fixture = await httpFixture('normal', undefined, 60000),
    t = createMcpServiceTransport({});
  const connections = Array.from({ length: 8 }, (_, n) => ({
    ...connection({ kind: 'http', url: fixture.url.href }),
    id: 'http' + n,
  }));
  const snapshots = [];
  const discover = (c: (typeof connections)[number]) =>
    t.discover(c, {
      signal: new AbortController().signal,
      deadlineMs: 2000,
      authorizeMetadata: () => true,
    });
  try {
    for (const c of connections) {
      const candidate = await discover(c),
        snapshot = { ...candidate, id: c.id };
      expect(t.activate(candidate, snapshot, () => true)).toBe(true);
      c.currentCatalogId = snapshot.id;
      snapshots.push(snapshot);
    }
    const candidate = await discover({ ...connections[0]!, configRevision: 2 }),
      snapshot = { ...candidate, id: 'replaced-http' };
    expect(t.activate(candidate, snapshot, () => true)).toBe(true);
    for (let n = 1; n < 8; n++) expect(t.ready(connections[n]!, snapshots[n]!)).toBe(true);
    await expect(discover({ ...connections[0]!, id: 'ninth' })).rejects.toMatchObject({
      code: 'execution_disabled',
    });
  } finally {
    await t.close();
    await fixture.close();
  }
});
it('refuses overdue full-cap HTTP replacement without aborting or stealing the admitted old call', async () => {
  const fixture = await httpFixture('defer-response', undefined, 60000),
    t = createMcpServiceTransport({});
  const connections = Array.from({ length: 8 }, (_, n) => ({
    ...connection({ kind: 'http', url: fixture.url.href }),
    id: 'drain' + n,
  }));
  const snapshots = [];
  const discover = (c: (typeof connections)[number], deadlineMs = 2000) =>
    t.discover(c, {
      signal: new AbortController().signal,
      deadlineMs,
      authorizeMetadata: () => true,
    });
  let call: ReturnType<typeof t.invoke> | undefined;
  try {
    for (const c of connections) {
      const candidate = await discover(c),
        snapshot = { ...candidate, id: c.id };
      t.activate(candidate, snapshot, () => true);
      c.currentCatalogId = snapshot.id;
      snapshots.push(snapshot);
    }
    let settled = false;
    call = t
      .invoke({
        connection: connections[0]!,
        catalogId: snapshots[0]!.id,
        definition: snapshots[0]!.tools[0]!,
        arguments: { value: 'alpha' },
        invocationId: 'held',
        signal: new AbortController().signal,
        deadlineMs: 2000,
        authorizeDispatch: () => true,
      })
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.waitFor(() => expect(fixture.stats.effects).toBe(1));
    const refreshing = discover({ ...connections[0]!, configRevision: 2 }, 30);
    expect(t.ready(connections[0]!, snapshots[0]!)).toBe(false);
    await expect(refreshing).rejects.toMatchObject({ code: 'catalog_incomplete' });
    expect(settled).toBe(false);
    expect(fixture.stats.effects).toBe(1);
    await expect(discover({ ...connections[0]!, id: 'ninth' })).rejects.toMatchObject({
      code: 'execution_disabled',
    });
    fixture.releaseResponse();
    expect((await call).kind).toBe('observed');
    expect(fixture.stats.effects).toBe(1);
    for (let n = 1; n < 8; n++) expect(t.ready(connections[n]!, snapshots[n]!)).toBe(true);
  } finally {
    fixture.releaseResponse();
    await call;
    await t.close();
    await fixture.close();
  }
});
