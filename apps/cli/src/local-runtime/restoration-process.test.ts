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
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
const phases = [
  'intent',
  'decision',
  'acquired',
  'preparing',
  'preparing-unsafe',
  'publishing',
  'published',
] as const;
const expected = {
  intent: 'refused',
  decision: 'held',
  acquired: 'held',
  preparing: 'held',
  'preparing-unsafe': 'held',
  publishing: 'held',
  published: 'ready',
} as const;
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
    const f = await codingWorkflowFixture('direct');
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
      fs.writeFileSync(join(f.worktree, 'answer.txt'), 'frozen before crash\n');
      f.runtime.close();
      fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      const inventory = stores.readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
      fs.writeFileSync(
        join(f.directory, 'coding-projects.json'),
        JSON.stringify([
          {
            id: 'project',
            root: f.project,
            testPresets: inventory.tasks[0]!.policy.testPresets,
            mounts: [],
          },
        ]),
        { mode: 0o600 },
      );
      const archive = join(root, 'archive');
      await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
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
        () =>
          expect(out, err).toBe(
            (phase === 'preparing' || phase === 'preparing-unsafe' ? 'preparing' : phase) + '\n',
          ),
        { timeout: 20000 },
      );
      child.kill('SIGKILL');
      expect((await exit).signal).toBe('SIGKILL');
      let lastRevision = -1;
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
        } finally {
          store.close();
        }
        const leases = [
          'acquired',
          'preparing',
          'preparing-unsafe',
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
      } else if (phase === 'preparing-unsafe') {
        await expect(backupProfile(profile, next)).rejects.toThrow('unsupported_rebind_output');
        expect(fs.existsSync(next)).toBe(false);
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
