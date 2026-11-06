import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type * as Server from './server.js';
import type * as Platform from '@runnets/tools-node';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime } from './host.js';
import { enrolledProfile } from '../../test-fixtures/mcp-enrolled-profile.js';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
function probeOwner(path: string): string {
  const script =
    "const m=await import(process.argv[2]);try{const release=m.ownSqliteRuntime(process.argv[1]);release();console.log('released');}catch(e){console.log(e.code??'unexpected');}";
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      path,
      new URL('../../../../packages/store-sqlite/dist/index.js', import.meta.url).href,
    ],
    { encoding: 'utf8' },
  ).trim();
}
const state = vi.hoisted(() => ({
  preflight: 0,
  failBind: false,
  binds: 0,
  held: Promise.resolve(),
}));
vi.mock('@runnets/tools-node', async (original) => ({
  ...(await original<typeof Platform>()),
  prepareManagedStdio: () => {
    state.preflight++;
    throw Error('synthetic native boundary');
  },
}));
vi.mock('./server.js', async (original) => {
  const server = await original<typeof Server>();
  return {
    ...server,
    listenLocalRuntime: async (...args: Parameters<typeof server.listenLocalRuntime>) => {
      if (state.failBind) {
        await state.held;
        await mkdir(args[0].descriptor.endpoint, { mode: 0o700 });
        state.binds++;
      }
      return server.listenLocalRuntime(...args);
    },
  };
});
it.each(['http', 'stdio'])(
  'maintenance on an ordinary enrolled %s profile does zero metadata/preflight and keeps grants',
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-maintenance-'));
    const f = await httpFixture('normal');
    const seeded = await enrolledProfile(
      dir,
      kind === 'http'
        ? { kind: 'http', url: f.url.href }
        : {
            kind: 'stdio',
            executable: join(dir, 'server.mjs'),
            sha256: 'a'.repeat(64),
            workspaceRoot: join(dir, 'workspace'),
            args: [],
          },
    );
    state.preflight = 0;
    let credentials = 0;
    try {
      const host = await startLocalRuntime({
        profile: seeded.profile,
        restore: true,
        provider: null,
        serviceTransportOptions: {
          resolveCredential: () => {
            credentials++;
            return kind === 'http' ? 'synthetic' : null;
          },
        },
      });
      expect(await host.stop()).toMatchObject({ outcome: 'complete' });
      expect([credentials, f.rows.length, state.preflight]).toEqual([0, 0, 0]);
      const store = openSqliteStore({ path: seeded.path });
      expect(
        store.serviceAuthority.atomic((tx) => ({
          connection: tx.connection('connection'),
          grants: tx.listGrants(),
        })),
      ).toEqual(seeded.before);
      store.close();
      console.log(
        JSON.stringify({
          scenario: 'maintenance-' + kind,
          credentials,
          metadata: f.rows.length,
          preflight: state.preflight,
          grantsUnchanged: true,
        }),
      );
    } finally {
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
it('actual failed host startup retains profile ownership while a started refresh continuation is held, then closes after proven drainage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-failed-host-'));
  const f = await httpFixture('normal');
  const seeded = await enrolledProfile(dir, { kind: 'http', url: f.url.href });
  let entered!: () => void, release!: () => void;
  state.held = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<void>((r) => {
    release = r;
  });
  state.failBind = true;
  state.binds = 0;
  let lists = 0;
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    if (typeof args[1]?.body === 'string' && args[1].body.includes('tools/list') && ++lists === 2) {
      entered();
      await held;
    }
    return original(...args);
  });
  try {
    const starting = startLocalRuntime({
      profile: seeded.profile,
      provider: null,
      drainDeadlineMs: 30,
      serviceTransportOptions: { resolveCredential: () => 'synthetic' },
    });
    const verdict = starting.then(
      () => 'unexpected host',
      (error: Error) => error.message,
    );
    await state.held;
    expect(await verdict).toBe('stop_incomplete');
    expect(state.binds).toBe(1);
    expect(() => createRuntime({ dbPath: seeded.path })).toThrow();
    expect(probeOwner(seeded.path)).toBe('owner_busy');
    const store = openSqliteStore({ path: seeded.path });
    expect(store.serviceAuthority.atomic((tx) => tx.connection('connection')?.configRevision)).toBe(
      3,
    );
    store.close();
    release();
    await vi.waitFor(
      async () => {
        const runtime = createRuntime({ dbPath: seeded.path });
        await runtime.ready;
        runtime.close();
      },
      { timeout: 2000 },
    );
    await delay(10);
    expect(f.rows.filter((method) => method === 'tools/list')).toHaveLength(1);
    expect(probeOwner(seeded.path)).toBe('released');
    console.log(
      JSON.stringify({
        scenario: 'failed-startup',
        verdict: 'stop_incomplete',
        pendingProbe: 'owner_busy',
        settledProbe: 'released',
        bindFailures: state.binds,
        observedLists: 1,
        lateLists: 0,
      }),
    );
  } finally {
    release();
    state.failBind = false;
    spy.mockRestore();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
