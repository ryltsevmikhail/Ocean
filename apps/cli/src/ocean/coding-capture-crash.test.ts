import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GitCodingSnapshots } from '@runnets/tools-node';
import { openSqliteStore } from '@runnets/store-sqlite';
import type { CodingAccess, CodingTask, CodingWorktree, Changeset } from '@runnets/domain';
import { codingWorkflowFixture, repairedMath } from './coding-workflow-fixture.js';
import { createRuntime, type Runtime } from '../runtime.js';

const count = (path: string, table: string): number => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(database.prepare('SELECT count(*) AS n FROM ' + table).get()!['n']);
  } finally {
    database.close();
  }
};
const payload = (path: string, hash: string): string => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare('SELECT payload FROM ocean_changesets WHERE hash=?').get(hash);
    return row === undefined ? '' : String(row['payload']);
  } finally {
    database.close();
  }
};
const row = (path: string, sql: string, ...values: string[]) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
};
const access = (runtime: Runtime, roomId: string): CodingAccess => {
  const inspected = runtime.coding.inspect('ws_ocean', 'task');
  if (!inspected.ok) throw Error('fixture task');
  return {
    workspaceId: 'ws_ocean',
    taskId: 'task',
    roomId,
    botId: inspected.value.devBotId,
    policyVersion: inspected.value.policyVersion,
    capability: 'project_read',
  };
};
async function reopen<T>(path: string, work: (runtime: Runtime) => Promise<T>): Promise<T> {
  const runtime = createRuntime({ dbPath: path });
  try {
    await runtime.ready;
    return await work(runtime);
  } finally {
    runtime.close();
  }
}
async function killedWorker(directory: string, room: string, phase: string): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), 'ocean-capture-run-'));
  try {
    const child = spawn(
      process.execPath,
      ['apps/cli/test-fixtures/coding-capture-crash-worker.test.ts', directory, room, phase],
      {
        cwd: process.cwd(),
        env: {
          ...(Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ) as Record<string, string>),
          PATH: process.env['PATH']!,
          XDG_RUNTIME_DIR: runDir,
        },
      },
    );
    let err = '',
      out = '';
    child.stderr.on('data', (buffer: Buffer) => {
      err += buffer.toString();
    });
    child.stdout.on('data', (buffer: Buffer) => {
      out += buffer.toString();
    });
    const exit = new Promise<[number | null, string | null]>((resolve) =>
      child.once('close', (code, signal) => resolve([code, signal])),
    );
    try {
      await vi.waitFor(() => expect(out, err).toBe(phase + '\n'), { timeout: 15000 });
    } finally {
      child.kill('SIGKILL');
    }
    expect(await exit).toEqual([null, 'SIGKILL']);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
it.runIf(process.platform === 'linux').each(['scan', 'artifact', 'committed'])(
  'qualifies the real changeset capture killed at %s across two reopenings',
  async (phase) => {
    const f = await codingWorkflowFixture('direct');
    const database = join(f.directory, 'runtime.sqlite');
    writeFileSync(join(f.worktree, 'math.cjs'), repairedMath);
    const inspected = f.runtime.coding.inspect('ws_ocean', 'task');
    if (!inspected.ok) throw Error('fixture task');
    const task = inspected.value;
    const store = openSqliteStore({ path: database });
    let worktree: CodingWorktree | null = null;
    try {
      worktree = store.coding.atomic((tx) => tx.worktree(task.id));
    } finally {
      store.close();
    }
    if (!worktree) throw Error('fixture worktree');
    const artifact = async (): Promise<Changeset> =>
      new GitCodingSnapshots().capture(task, worktree!);
    const expected = JSON.stringify(await artifact());
    const hash = (JSON.parse(expected) as Changeset).hash;
    f.runtime.close();
    try {
      chmodSync(database, 0o600);
      await killedWorker(f.directory, f.room, phase);
      const rows = () => ({
        changesets: count(database, 'ocean_changesets'),
        receipts: count(database, 'ocean_capture_receipts'),
      });
      if (phase === 'committed') {
        // The artifact and its capture receipt committed together before death.
        expect(rows()).toEqual({ changesets: 1, receipts: 1 });
        expect(payload(database, hash)).toBe(expected);
        const original = GitCodingSnapshots.prototype.capture;
        let scans = 0;
        GitCodingSnapshots.prototype.capture = async function (
          this: GitCodingSnapshots,
          ...args: [CodingTask, CodingWorktree]
        ) {
          scans++;
          return original.apply(this, args);
        };
        try {
          for (let index = 0; index < 2; index++) {
            await reopen(database, async (runtime) => {
              const again = await runtime.codingChanges.capture(
                access(runtime, f.room),
                'crash-request',
              );
              expect(again.ok).toBe(true);
              if (!again.ok) return;
              expect(JSON.stringify(again.value)).toBe(expected);
              expect(payload(database, again.value.hash)).toBe(expected);
              expect(rows()).toEqual({ changesets: 1, receipts: 1 });
              expect(
                row(
                  database,
                  'SELECT hash FROM ocean_capture_receipts WHERE request_id=?',
                  'crash-request',
                ),
              ).toMatchObject({ hash });
            });
          }
        } finally {
          GitCodingSnapshots.prototype.capture = original;
        }
        expect(scans).toBe(0);
      } else {
        // Nothing durable may survive a scan or an uncommitted artifact transaction.
        for (let index = 0; index < 2; index++)
          await reopen(database, async (runtime) => {
            expect(rows()).toEqual({ changesets: 0, receipts: 0 });
            expect(runtime.codingChanges.read(access(runtime, f.room), hash)).toMatchObject({
              ok: false,
            });
            expect(
              row(
                database,
                'SELECT hash FROM ocean_capture_receipts WHERE request_id=?',
                'crash-request',
              ),
            ).toBeUndefined();
          });
        if (phase === 'scan') writeFileSync(join(f.worktree, 'later.txt'), 'later\n');
      }
      // A retry is a fresh capture: it either matches the frozen tree or the current one.
      const current = JSON.stringify(await artifact());
      await reopen(database, async (runtime) => {
        const captured = await runtime.codingChanges.capture(
          access(runtime, f.room),
          'crash-request',
        );
        expect(captured.ok).toBe(true);
        if (!captured.ok) return;
        expect(JSON.stringify(captured.value)).toBe(current);
        expect(payload(database, captured.value.hash)).toBe(current);
        expect(rows()).toEqual({ changesets: 1, receipts: 1 });
        const replay = await runtime.codingChanges.capture(
          access(runtime, f.room),
          'crash-request',
        );
        expect(replay.ok && JSON.stringify(replay.value)).toBe(current);
        expect(rows()).toEqual({ changesets: 1, receipts: 1 });
      });
      if (phase === 'scan') {
        // The interrupted scan froze nothing: the committed retry saw the later tree.
        expect(current).not.toBe(expected);
        return;
      }
      // An old request can never be redirected to a later tree; a new one is a new artifact.
      writeFileSync(join(f.worktree, 'later.txt'), 'later\n');
      await reopen(database, async (runtime) => {
        const frozen = await runtime.codingChanges.capture(
          access(runtime, f.room),
          'crash-request',
        );
        expect(frozen.ok && JSON.stringify(frozen.value)).toBe(expected);
        expect(payload(database, hash)).toBe(expected);
        const later = await runtime.codingChanges.capture(access(runtime, f.room), 'later-request');
        expect(later.ok).toBe(true);
        if (!later.ok) return;
        expect(later.value.hash).not.toBe(hash);
        expect(rows()).toEqual({ changesets: 2, receipts: 2 });
        expect(payload(database, hash)).toBe(expected);
      });
      expect(readFileSync(join(f.worktree, 'later.txt'), 'utf8')).toBe('later\n');
    } finally {
      f.close();
    }
  },
  60000,
);
