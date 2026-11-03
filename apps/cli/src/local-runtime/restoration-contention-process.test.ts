import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openSqliteStore, readCodingBackupInventory } from '@runnets/store-sqlite';
import { connectLocalRuntime, SqliteProjectLeases } from '@runnets/tools-node';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';

function filesHash(directory: string): string {
  const hash = createHash('sha256');
  const walk = (path: string, relative: string) => {
    for (const name of fs.readdirSync(path).sort()) {
      if (relative === '' && name === '.git') continue;
      const child = join(path, name),
        key = relative === '' ? name : relative + '/' + name,
        entry = fs.lstatSync(child);
      if (entry.isDirectory()) walk(child, key);
      else if (entry.isSymbolicLink())
        hash.update('link\0' + key + '\0' + fs.readlinkSync(child) + '\0');
      else
        hash.update(
          'file\0' + key + '\0' + (entry.mode & 0o777).toString(8) + '\0' + fs.readFileSync(child),
        );
    }
  };
  walk(directory, '');
  return hash.digest('hex');
}
function registry(home: string): { token: string; root: string }[] {
  const db = new DatabaseSync(join(home, '.local/state/ocean-coordination/leases.sqlite'), {
    readOnly: true,
  });
  try {
    return db.prepare('SELECT token,root FROM project_leases_v1 ORDER BY token').all() as {
      token: string;
      root: string;
    }[];
  } finally {
    db.close();
  }
}
const clone = (source: string, destination: string) => {
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', source, destination], {
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
};
it('keeps a live original lease and files intact while a separate restored owner contends the same root', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'rebind-contention-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  fs.mkdirSync(join(root, 'run'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  const f = await codingWorkflowFixture('direct');
  const leases = new SqliteProjectLeases();
  let original: ReturnType<typeof leases.acquire> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const selected = join(root, 'selected'),
      fresh = join(root, 'fresh-project');
    clone(f.project, selected);
    clone(f.project, fresh);
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'contended restored marker\n');
    await f.capture('contention-marker');
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const task = readCodingBackupInventory(join(f.directory, 'runtime.sqlite')).tasks[0]!;
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        { id: 'project', root: f.project, testPresets: task.policy.testPresets, mounts: [] },
      ]),
      { mode: 0o600 },
    );
    await backupProfile(f.directory, join(root, 'archive'), {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.directory, { recursive: true });
    const profile = join(root, 'profile');
    restoreProfile(join(root, 'archive'), profile);
    fs.rmSync(join(root, 'archive'), { recursive: true });
    // The ORIGINAL live profile still owns the exact selected root through the real
    // cross-process coordination registry in this parent process.
    original = leases.acquire(selected, {
      ownerId: 'original-live-owner',
      taskId: 'original-task',
      requestId: 'original-start',
      binding: 'original-binding',
      kind: 'coding',
    });
    expect(original.ok).toBe(true);
    if (!original.ok) throw Error('fixture_lease');
    const tree = filesHash(selected),
      base = registry(join(root, 'home'));
    expect(base.filter((row) => row.root === selected)).toHaveLength(1);
    const env = Object.fromEntries(
      [
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    );
    let output = '';
    child = spawn(
      process.execPath,
      ['apps/cli/dist/main.js', 'runtime', 'restore', '--profile', profile],
      {
        env: {
          ...env,
          PATH: process.env['PATH'],
          HOME: join(root, 'home'),
          XDG_RUNTIME_DIR: join(root, 'run'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (b: Buffer) => (output += b.toString()));
    child.stderr!.on('data', (b: Buffer) => (output += b.toString()));
    let lastError = 'none';
    const client = await (async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          return await connectLocalRuntime({ profile });
        } catch (error) {
          lastError =
            error instanceof Error
              ? JSON.stringify({ message: error.message, stack: error.stack })
              : JSON.stringify(error);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw Error('maintenance_host_unreachable:' + lastError + ':' + output);
    })();
    try {
      const same = await client.inspectRestore({
        workspaceId: 'ws_ocean',
        roomId: f.room,
        taskId: task.id,
        requestId: 'same-root',
        projectRoot: selected,
        policy: task.policy,
      });
      const card = await client.previewRestore(same.selection);
      await client.resolveDecision({
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
        bindingDigest: card.bindingDigest,
        choice: 'allow-once',
        expectedVersion: card.version,
      });
      const poll = async (selection: typeof same.selection) => {
        const deadline = Date.now() + 60000;
        let result = await client.restoreResult(selection);
        while (!['ready', 'held', 'refused'].includes(result.state) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          result = await client.restoreResult(selection);
        }
        return result;
      };
      const contended = await poll(same.selection);
      expect(contended.state, contended.reason ?? '').toBe('refused');
      expect(contended.reason).toBe('project_busy');
      // The original owner's lease, registry rows and selected working files are exact.
      expect(leases.owns(original.value)).toBe(true);
      expect(registry(join(root, 'home'))).toEqual(base);
      expect(filesHash(selected)).toBe(tree);
      expect(
        execFileSync('/usr/bin/git', ['-C', selected, 'status', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).toBe('');
      // A genuinely different clean root at the same base succeeds in the same child.
      const other = await client.inspectRestore({
        workspaceId: 'ws_ocean',
        roomId: f.room,
        taskId: task.id,
        requestId: 'new-root',
        projectRoot: fresh,
        policy: task.policy,
      });
      const freshCard = await client.previewRestore(other.selection);
      await client.resolveDecision({
        workspaceId: freshCard.workspaceId,
        roomId: freshCard.roomId,
        runId: freshCard.runId,
        decisionId: freshCard.decisionId,
        bindingDigest: freshCard.bindingDigest,
        choice: 'allow-once',
        expectedVersion: freshCard.version,
      });
      const deadline = Date.now() + 60000;
      let ready = await client.restoreResult(other.selection);
      while (!['ready', 'held', 'refused'].includes(ready.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ready = await client.restoreResult(other.selection);
      }
      expect(ready.state, ready.reason ?? '').toBe('ready');
      expect(ready.successorTaskId).toBeTruthy();
      const after = registry(join(root, 'home'));
      expect(after.filter((row) => row.root === selected)).toEqual(
        base.filter((row) => row.root === selected),
      );
      expect(after.filter((row) => row.root === fresh)).toHaveLength(1);
      expect(after.filter((row) => row.root.includes('rebind-' + ready.epochId))).toHaveLength(1);
      expect(after).toHaveLength(base.length + 2);
      expect(leases.owns(original.value)).toBe(true);
      expect(filesHash(selected)).toBe(tree);
      // The refused record is durable and carries no partial binding or lease.
      expect((await client.restoreResult(same.selection)).state).toBe('refused');
      expect(fs.existsSync(join(profile, 'rebind-' + ready.epochId))).toBe(true);
      const stopped = await client.stop();
      expect(stopped.outcome).toBe('complete');
    } finally {
      client.close();
    }
    const exit = new Promise<number | null>((resolve) =>
      child!.once('exit', (code) => resolve(code)),
    );
    expect(await exit).toBe(0);
    const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
    try {
      expect(store.rebind.atomic((tx) => tx.record('same-root'))).toMatchObject({
        state: 'refused',
        reason: 'project_busy',
        projectLease: null,
        worktreeLease: null,
        result: null,
      });
      const active = store.rebind.active()!;
      expect(active.requestId).toBe('new-root');
      expect(readCodingBackupInventory(join(profile, 'runtime.sqlite')).tasks).toHaveLength(2);
      expect(store.coding.atomic((tx) => tx.task(active.result!.task.id))).not.toBeNull();
    } finally {
      store.close();
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (original?.ok) leases.release(original.value);
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 180000);
