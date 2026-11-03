import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import { createRuntime } from '../runtime.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import { codingDesktopFixture } from '../ocean/desktop-workflow-fixture.js';
const phases = [
  'intent',
  'decision',
  'acquired',
  'preparing',
  'preparing-unsafe',
  'preparing-git-admin',
  'preparing-registration',
  'prepared',
  'publishing',
  'published',
] as const;
const expected = {
  intent: 'refused',
  decision: 'held',
  acquired: 'held',
  preparing: 'held',
  'preparing-unsafe': 'held',
  'preparing-git-admin': 'held',
  'preparing-registration': 'held',
  prepared: 'held',
  publishing: 'held',
  published: 'ready',
} as const;
const halted = new Set([
  'preparing',
  'preparing-unsafe',
  'preparing-git-admin',
  'preparing-registration',
]);
function registry(root: string): { rows: number; roots: string[] } {
  const path = join(root, 'home', '.local/state/ocean-coordination/leases.sqlite');
  if (!fs.existsSync(path)) return { rows: 0, roots: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT root FROM project_leases_v1').all();
    return { rows: rows.length, roots: rows.map((r) => String(r['root'])) };
  } finally {
    db.close();
  }
}
it.each(phases)(
  'kills a real restored rebind at %s and reopens twice without retry',
  async (phase) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'rebind-crash-'));
    fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
    vi.stubEnv('HOME', join(root, 'home'));
    const f = await codingDesktopFixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const selected = join(root, 'selected');
      execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
        env: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      const archive = join(root, 'archive');
      await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
      const archived = stores.readDesktopBackupInventory(join(f.directory, 'runtime.sqlite'));
      fs.rmSync(f.directory, { recursive: true });
      const profile = join(root, 'profile');
      restoreProfile(archive, profile);
      fs.rmSync(archive, { recursive: true });
      const registryBase = registry(root).rows;
      const env = Object.fromEntries(
        [
          'HOME',
          'XDG_RUNTIME_DIR',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
          'XDG_CACHE_HOME',
          'TMPDIR',
          'LANG',
          'LC_ALL',
        ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
      );
      child = spawn(
        process.execPath,
        ['apps/cli/test-fixtures/rebind-crash-worker.test.ts', profile, selected, phase],
        { env: { ...env, PATH: process.env['PATH'], HOME: join(root, 'home') } },
      );
      let out = '',
        err = '';
      child.stdout!.on('data', (b: Buffer) => {
        out += b.toString();
      });
      child.stderr!.on('data', (b: Buffer) => {
        err += b.toString();
      });
      const exit = new Promise<{ signal: string | null; code: number | null }>((resolve) =>
        child!.once('close', (code, signal) => resolve({ code, signal })),
      );
      await vi.waitFor(
        () => expect(out, err).toBe((halted.has(phase) ? 'preparing' : phase) + '\n'),
        { timeout: 20000 },
      );
      child.kill('SIGKILL');
      expect((await exit).signal).toBe('SIGKILL');
      let lastRevision = -1,
        preparedInode = -1;
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = stores.openSqliteStore({ path: join(profile, 'runtime.sqlite') });
        try {
          store.rebind.recover();
          const record = store.rebind.atomic((tx) => tx.record('crash-rebind'))!;
          expect(record.state).toBe(expected[phase]);
          expect(record.revision).toBeGreaterThanOrEqual(lastRevision);
          lastRevision = record.revision;
          expect(store.coding.atomic((tx) => tx.task('task'))).not.toBeNull();
          if (phase === 'published') {
            expect(store.rebind.active()!.result!.task.worktreeRoot).toBeTruthy();
            expect(
              store.coding.atomic((tx) => tx.task(record.preview.successorTaskId)),
            ).not.toBeNull();
          } else {
            expect(store.rebind.active()).toBeNull();
            expect(store.coding.atomic((tx) => tx.task(record.preview.successorTaskId))).toBeNull();
            if (['intent', 'decision', 'acquired'].includes(phase))
              expect(record.projectLease).toBeNull();
            else expect(record.projectLease).not.toBeNull();
          }
          if (phase === 'preparing') {
            expect(
              fs.readFileSync(join(record.preview.plan.managedDirectory, 'partial.txt'), 'utf8'),
            ).toBe('partial materialization\n');
          }
          if (phase === 'prepared') {
            // Materialized new-profile Desktop storage is retained, but no binding was published.
            const planned = record.preview.plan.desktop!;
            expect(fs.existsSync(planned.root)).toBe(true);
            expect(planned.identity).toBeNull();
            expect(fs.realpathSync(planned.root)).toBe(planned.root);
            expect(fs.readdirSync(profile).filter((name) => name.startsWith('desktop-'))).toEqual([
              'desktop-' + record.preview.epochId,
            ]);
            const inode = fs.statSync(planned.root).ino;
            if (preparedInode >= 0) expect(inode).toBe(preparedInode);
            preparedInode = inode;
            const inventory = stores.readDesktopBackupInventory(join(profile, 'runtime.sqlite'));
            expect(inventory.binding).toEqual(archived.binding);
            expect(
              inventory.operations.filter((operation) => operation.state === 'started'),
            ).toEqual([expect.objectContaining({ id: expect.stringContaining('prepare:') })]);
            expect(
              inventory.operations.filter((operation) => operation.state === 'completed'),
            ).toHaveLength(2);
          }
        } finally {
          store.close();
        }
        const leases = [
          'acquired',
          'preparing',
          'preparing-unsafe',
          'preparing-git-admin',
          'preparing-registration',
          'prepared',
          'publishing',
          'published',
        ].includes(phase)
          ? phase === 'acquired'
            ? 1
            : 2
          : 0;
        expect(registry(root).rows).toBe(registryBase + leases);
      }
      if (phase === 'acquired')
        expect(registry(root).roots.filter((r) => r === selected)).toHaveLength(1);
      if (phase === 'published') {
        const runtime = createRuntime({ dbPath: join(profile, 'runtime.sqlite') });
        await runtime.ready;
        expect(runtime.restored).toBe(false);
        runtime.close();
      } else {
        expect(() => createRuntime({ dbPath: join(profile, 'runtime.sqlite') })).toThrow(
          'restore_restricted',
        );
      }
      const next = join(root, 'next-archive');
      if (phase === 'preparing') {
        const manifest = await backupProfile(profile, next);
        const intents = manifest.lineage!.intents;
        expect(intents.map((i) => i.state)).toEqual(['held']);
        const held = intents[0]!;
        expect(held.outputs.map((o) => o.kind)).toEqual([
          'materialization',
          'git-administration',
          'git-reference',
          'desktop',
          'registration',
        ]);
        expect(held.outputs.find((o) => o.kind === 'materialization')).toMatchObject({
          presence: 'captured',
        });
        for (const output of held.outputs.filter((o) => o.kind !== 'materialization'))
          expect(output).toMatchObject({ presence: 'absent', manifestHash: null });
        const graph = adapters.verifyProfileLineageGraph(next, stores.readProfileRestoreSnapshot);
        expect(graph.manifest.lineage!.intents).toEqual(intents);
        const again = join(root, 'again');
        restoreProfile(next, again);
        const reopened = stores.openSqliteStore({ path: join(again, 'runtime.sqlite') });
        try {
          reopened.rebind.recover();
          expect(reopened.rebind.atomic((tx) => tx.record('crash-rebind'))!.state).toBe('held');
          expect(reopened.rebind.active()).toBeNull();
          expect(reopened.rebind.atomic((tx) => tx.busy())).toBe(false);
        } finally {
          reopened.close();
        }
        expect(() => createRuntime({ dbPath: join(again, 'runtime.sqlite') })).toThrow(
          'restore_restricted',
        );
      } else if (
        ['preparing-unsafe', 'preparing-git-admin', 'preparing-registration'].includes(phase)
      ) {
        await expect(backupProfile(profile, next)).rejects.toThrow('unsupported_rebind_output');
        expect(fs.existsSync(next)).toBe(false);
        const owner = stores.openSqliteStore({ path: join(profile, 'runtime.sqlite') });
        const plan = (() => {
          try {
            return owner.rebind.atomic((tx) => tx.record('crash-rebind'))!.preview.plan;
          } finally {
            owner.close();
          }
        })();
        // Refusal never discards the unprovable partial evidence it refused to archive.
        if (phase === 'preparing-unsafe')
          expect(fs.readlinkSync(join(plan.managedDirectory, 'workspace'))).toBe('missing-slot');
        if (phase === 'preparing-git-admin')
          expect(fs.readFileSync(join(plan.gitAdministration, 'gitdir'), 'utf8')).toBe(
            '/unowned/worktree/.git\n',
          );
        if (phase === 'preparing-registration')
          expect(fs.readFileSync(join(profile, 'coding-projects.json'), 'utf8')).toBe('{"torn"');
      }
    } finally {
      child?.kill('SIGKILL');
      f.close();
      fs.rmSync(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  120000,
);
