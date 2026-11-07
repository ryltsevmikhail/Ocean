import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import type * as Child from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connection } from '../test-fixtures/admission.js';
import { createMcpServiceTransport } from './index.js';

const hold = vi.hoisted(() => ({ root: '', reads: 0, commands: 0, release: Promise.resolve() }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]) === hold.root) {
        hold.reads++;
        await hold.release;
      }
      return fs.realpath(...args);
    },
  };
});
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof Child>();
  return {
    ...cp,
    execFile: (...args: Parameters<typeof cp.execFile>) => {
      if (args[0] === '/usr/bin/systemctl') {
        hold.commands++;
        throw Error('no command permitted');
      }
      return cp.execFile(...args);
    },
  };
});
it.each(['deadline', 'cancel'])(
  'returns at %s while accounting for every held native preflight',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-preflight-'));
    const workspace = join(dir, 'workspace'),
      profileRoot = join(dir, 'profile'),
      file = join(dir, 'server.mjs');
    await mkdir(workspace);
    await mkdir(profileRoot);
    await writeFile(file, 'fixture');
    const c = connection({
      kind: 'stdio',
      executable: file,
      sha256: createHash('sha256').update('fixture').digest('hex'),
      args: [],
    });
    const t = createMcpServiceTransport({
      stdio: {
        profileRoot,
        workspaces: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [c.id + n, workspace])),
      },
    });
    const starts = vi.spyOn(StdioClientTransport.prototype, 'start');
    let release!: () => void;
    hold.root = workspace;
    hold.reads = hold.commands = 0;
    hold.release = new Promise<void>((r) => {
      release = r;
    });
    const ac = new AbortController();
    const discover = (_: unknown, n: number) =>
      t.discover(
        { ...c, id: c.id + n },
        {
          signal: ac.signal,
          deadlineMs: mode === 'deadline' ? 250 : 2000,
          authorizeMetadata: () => true,
        },
      );
    const calls = Promise.allSettled(Array.from({ length: 8 }, discover));
    try {
      await vi.waitFor(() => expect(hold.reads).toBe(8), { timeout: 200 });
      if (mode === 'cancel') ac.abort();
      const beforeRelease = await Promise.race([
        calls.then((r) => r.every((x) => x.status === 'rejected')),
        delay(600, false),
      ]);
      const fresh = t
        .discover(c, {
          signal: new AbortController().signal,
          deadlineMs: 2000,
          authorizeMetadata: () => true,
        })
        .then(
          () => '',
          (e: { code: string }) => e.code,
        );
      const capacity = await Promise.race([fresh, delay(100, 'slot was reused')]);
      expect(capacity).toBe('execution_disabled');
      const closing = t.close();
      expect(await Promise.race([closing.then(() => true), delay(30, false)])).toBe(false);
      release();
      await calls;
      expect(await closing).toEqual({ status: 'never_started' });
      expect([beforeRelease, hold.commands, starts.mock.calls.length]).toEqual([true, 0, 0]);
    } finally {
      release();
      await calls;
      await t.close();
      starts.mockRestore();
      await rm(dir, { recursive: true });
    }
  },
);
it('keeps a replaced same-connection preflight counted until its held kernel work unwinds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-replaced-preflight-'));
  const workspace = join(dir, 'workspace'),
    profileRoot = join(dir, 'profile'),
    file = join(dir, 'server.mjs');
  await mkdir(workspace);
  await mkdir(profileRoot);
  await writeFile(file, 'fixture');
  const c = connection({
    kind: 'stdio',
    executable: file,
    sha256: createHash('sha256').update('fixture').digest('hex'),
    args: [],
  });
  const t = createMcpServiceTransport({
    stdio: {
      profileRoot,
      workspaces: Object.fromEntries(
        ['fresh', c.id, ...Array.from({ length: 6 }, (_, n) => c.id + n)].map((id) => [
          id,
          workspace,
        ]),
      ),
    },
  });
  let release!: () => void;
  hold.root = workspace;
  hold.reads = hold.commands = 0;
  hold.release = new Promise<void>((r) => {
    release = r;
  });
  const ac = new AbortController();
  const discover = (id: string) =>
    t.discover(
      { ...c, id },
      { signal: ac.signal, deadlineMs: 2000, authorizeMetadata: () => true },
    );
  const first = Promise.allSettled([discover(c.id)]);
  let rest = Promise.resolve([] as PromiseSettledResult<unknown>[]);
  try {
    await vi.waitFor(() => expect(hold.reads).toBe(1), { timeout: 200 });
    rest = Promise.allSettled([
      discover(c.id),
      ...Array.from({ length: 6 }, (_, n) => discover(c.id + n)),
    ]);
    await vi.waitFor(() => expect(hold.reads).toBeGreaterThanOrEqual(7), { timeout: 200 });
    const capacity = await Promise.race([
      discover('fresh').then(
        () => 'accepted',
        () => 'refused',
      ),
      delay(50, 'slot reused'),
    ]);
    expect(capacity).toBe('refused');
    expect(hold.reads).toBe(7);
  } finally {
    ac.abort();
    release();
    await first;
    await rest;
    await t.close();
    await rm(dir, { recursive: true, force: true });
  }
});
