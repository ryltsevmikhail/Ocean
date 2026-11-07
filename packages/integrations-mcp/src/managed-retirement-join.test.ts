import { expect, it, vi } from 'vitest';
import type { SessionWriter } from './session-writer.js';
import { createMcpServiceTransport } from './index.js';
import { connection } from '../test-fixtures/admission.js';
import { httpFixture } from './prototype-http-fixture.js';
const state = vi.hoisted(() => ({
  url: '',
  held: false,
  enter: () => {},
  wait: Promise.resolve(),
  unknown: false,
  serial: 0,
}));
vi.mock('./stdio.js', async () => {
  const { serviceHttp } = await import('./http.js');
  return {
    serviceStdio: async (_c: unknown, _o: unknown, writer: SessionWriter) => {
      const fingerprint = (++state.serial).toString(16).padStart(64, '0');
      writer.managedSession = fingerprint;
      return {
        transport: serviceHttp(state.url, null, false, writer),
        managed: {
          handle: {},
          lifetime: { record: { fingerprint } },
          signal: writer.lifetime,
          prepareResources: (work: Parameters<SessionWriter['ownResources']>[0]) =>
            writer.ownResources(work),
        },
        lost() {},
        prepareRetirement: async () => {},
        cleanup: async () => {
          if (state.held) {
            state.enter();
            await state.wait;
          }
          return { status: state.unknown ? 'unknown' : 'confirmed' };
        },
      };
    },
  };
});
it.each(['refresh', 'disconnect'] as const)(
  'joins the exact lost generation after %s removed its active mapping',
  async (transition) => {
    const f = await httpFixture('defer-response');
    state.url = f.url.href;
    state.serial = 0;
    state.unknown = false;
    const t = createMcpServiceTransport({});
    const c = connection({
      kind: 'stdio',
      executable: '/owned/server.mjs',
      sha256: 'a'.repeat(64),
      workspaceRoot: '/owned/root',
      args: [],
    });
    const discover = () =>
      t.discover(c, {
        signal: new AbortController().signal,
        deadlineMs: 2000,
        authorizeMetadata: () => true,
      });
    let release!: () => void, entered!: () => void;
    state.wait = new Promise<void>((r) => {
      release = r;
    });
    const cleanupEntered = new Promise<void>((r) => {
      entered = r;
    });
    state.enter = entered;
    let refreshing: Promise<unknown> | undefined;
    let closeProof!: () => void;
    const heldProof = new Promise<void>((r) => {
      closeProof = r;
    });
    try {
      const candidate = await discover(),
        snapshot = { ...candidate, id: 'active' };
      t.activate(candidate, snapshot, () => true);
      const live = { ...c, currentCatalogId: snapshot.id },
        generation = t.managed(live)!.lifetime.record.fingerprint;
      const proof = await t.managed(live)!.prepareResources(async () => ({
        facts: { pairs: [] },
        inspect: () => true,
        close: () => heldProof,
      }));
      const ac = new AbortController();
      const call = t.invoke({
        connection: live,
        catalogId: snapshot.id,
        definition: snapshot.tools[0]!,
        arguments: { value: 'alpha' },
        invocationId: 'lost',
        signal: ac.signal,
        deadlineMs: 2000,
        managedSession: generation,
        authorizeDispatch: () => true,
      });
      await vi.waitFor(() => expect(f.stats.effects).toBe(1));
      state.held = true;
      if (transition === 'refresh') refreshing = discover().catch(() => null);
      else t.disconnect(c.id);
      ac.abort();
      expect((await call).kind).toBe('uncertain');
      let proofClosed = false;
      const proofClosing = Promise.resolve(proof.close()).then(() => {
        proofClosed = true;
      });
      await new Promise<void>((r) => setImmediate(r));
      expect(proofClosed).toBe(false);
      closeProof();
      await proofClosing;
      await cleanupEntered;
      let joined = false;
      const retirement = t.retireUncertain!(live, generation).then(() => {
        joined = true;
      });
      await new Promise<void>((r) => setImmediate(r));
      expect(joined).toBe(false);
      state.held = false;
      release();
      await retirement;
      await refreshing;
      expect(joined).toBe(true);
      expect([f.stats.calls, f.stats.effects]).toEqual([1, 1]);
    } finally {
      closeProof();
      state.held = false;
      release();
      f.releaseResponse();
      await refreshing;
      await t.close();
      await f.close();
    }
  },
);

it.each([false, true])(
  'keeps success, missing/stale generation denial and cleanup uncertainty=%s conservative',
  async (unknown) => {
    const f = await httpFixture('normal');
    state.url = f.url.href;
    state.serial = 0;
    state.unknown = unknown;
    state.held = false;
    const t = createMcpServiceTransport({}),
      c = connection({
        kind: 'stdio',
        executable: '/owned/server.mjs',
        sha256: 'a'.repeat(64),
        workspaceRoot: '/owned/root',
        args: [],
      });
    const discover = () =>
      t.discover(c, {
        signal: new AbortController().signal,
        deadlineMs: 2000,
        authorizeMetadata: () => true,
      });
    try {
      const candidate = await discover(),
        snapshot = { ...candidate, id: 'control' };
      expect(t.activate(candidate, snapshot, () => true)).toBe(true);
      const live = { ...c, currentCatalogId: snapshot.id },
        generation = t.managed(live)!.lifetime.record.fingerprint;
      const input = {
        connection: live,
        catalogId: snapshot.id,
        definition: snapshot.tools[0]!,
        arguments: { value: 'alpha' },
        invocationId: 'control',
        signal: new AbortController().signal,
        deadlineMs: 2000,
        authorizeDispatch: () => true,
      };
      await t.retireUncertain!(live);
      await t.retireUncertain!(live, 'f'.repeat(64));
      expect(t.ready(live, snapshot)).toBe(true);
      expect((await t.invoke({ ...input, managedSession: generation })).kind).toBe('observed');
      expect(f.stats.effects).toBe(1);
      expect((await t.invoke({ ...input, invocationId: 'missing' })).kind).toBe('not_started');
      expect(
        (await t.invoke({ ...input, invocationId: 'stale', managedSession: 'f'.repeat(64) })).kind,
      ).toBe('not_started');
      expect(f.stats.effects).toBe(1);
      t.disconnect(c.id);
      expect(await t.close()).toEqual({ status: unknown ? 'unknown' : 'confirmed' });
      if (unknown) await expect(discover()).rejects.toMatchObject({ code: 'execution_disabled' });
    } finally {
      await t.close();
      await f.close();
    }
  },
);
