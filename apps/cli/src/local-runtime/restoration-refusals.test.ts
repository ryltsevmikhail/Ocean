import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { LocalRestoreSelection } from '@runnets/contracts';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
import { createRuntime } from '../runtime.js';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';

function leases(root: string): { token: string; root: string }[] {
  const path = join(root, 'home', '.local/state/ocean-coordination/leases.sqlite');
  if (!fs.existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT token,root FROM project_leases_v1 ORDER BY token').all() as {
      token: string;
      root: string;
    }[];
  } finally {
    db.close();
  }
}

// Whole native Git/SQLite recovery lifecycle; measured above the 5s unit-test default.
it('refuses the whole public inspection/preview matrix and an explicit restore without its marker', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'restore-refusals-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const f = await codingWorkflowFixture('direct');
  let host: LocalRuntimeHost | undefined;
  try {
    const selected = join(root, 'selected');
    execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'restored refusal marker\n');
    await f.capture('archive-marker');
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
    host = await startLocalRuntime({ profile, restore: true, provider: null });
    const client = await connectLocalRuntime({ profile });
    try {
      const inspect = {
        workspaceId: 'ws_ocean',
        roomId: f.room,
        requestId: 'refusal-inspect',
        taskId: task.id,
        projectRoot: selected,
        policy: task.policy,
      };
      const inspection = await client.inspectRestore(inspect);
      expect(inspection.selection.taskId).toBe(task.id);
      await expect(
        client.inspectRestore({ ...inspect, requestId: 'wrong-task', taskId: 'missing' }),
      ).rejects.toThrow('rebind_scope_conflict');
      await expect(
        client.inspectRestore({ ...inspect, requestId: 'wrong-room', roomId: 'foreign' }),
      ).rejects.toThrow('rebind_scope_conflict');
      await expect(
        client.inspectRestore({
          ...inspect,
          requestId: 'old-policy',
          policy: { ...task.policy, version: 2 } as unknown as typeof inspect.policy,
        }),
      ).rejects.toThrow('invalid_params');
      // A different project history is not the recorded base and refuses before preview.
      const other = join(root, 'other-project');
      execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', selected, other], {
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'] },
      });
      execFileSync(
        '/usr/bin/git',
        [
          '-C',
          other,
          '-c',
          'user.name=x',
          '-c',
          'user.email=x@invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'next',
        ],
        { env: { PATH: process.env['PATH'], HOME: process.env['HOME'] } },
      );
      await expect(
        client.inspectRestore({ ...inspect, requestId: 'wrong-base', projectRoot: other }),
      ).rejects.toThrow('rebind_project_changed');

      // The still-live original fixture owns its real registry leases; refusals must
      // add nothing to or remove anything from that unchanged coordination state.
      const baseline = leases(root);
      expect(baseline).toHaveLength(2);
      const selection: LocalRestoreSelection = inspection.selection;
      const cases: readonly [string, LocalRestoreSelection, string][] = [
        ['wrong room', { ...selection, roomId: 'foreign' }, 'rebind_scope_conflict'],
        ['wrong profile', { ...selection, profileId: 'f'.repeat(64) }, 'rebind_scope_conflict'],
        ['wrong snapshot', { ...selection, snapshotId: 'f'.repeat(64) }, 'rebind_scope_conflict'],
        ['wrong owner', { ...selection, sourceOwnerId: 'foreign' }, 'rebind_scope_conflict'],
        ['wrong task', { ...selection, taskId: 'missing' }, 'rebind_scope_conflict'],
        ['wrong base', { ...selection, baseCommit: 'c'.repeat(40) }, 'rebind_scope_conflict'],
        ['wrong tree', { ...selection, treeHash: 'c'.repeat(64) }, 'rebind_project_changed'],
        ['wrong project', { ...selection, projectRoot: other }, 'rebind_project_changed'],
      ];
      for (const [name, value, code] of cases) {
        await expect(client.previewRestore(value), name).rejects.toThrow(code);
      }
      expect(leases(root)).toEqual(baseline);

      // A preview is invalidated when the selected project tree changes before resolve.
      const card = await client.previewRestore({ ...selection, requestId: 'stale-preview' });
      fs.writeFileSync(join(selected, 'untracked-late.txt'), 'changed before confirmation\n');
      const resolved = await client.resolveDecision({
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
        bindingDigest: card.bindingDigest,
        choice: 'allow-once',
        expectedVersion: card.version,
      });
      expect(resolved.status).toBe('invalidated');
      const stale = await client.restoreResult({ ...selection, requestId: 'stale-preview' });
      expect(stale.state, stale.reason ?? '').toBe('refused');
      expect(stale.reason).toBe('invalidated');
      expect(stale.successorTaskId).toBeTruthy();
      // Re-resolving the old card cannot create authority or a lease.
      const again = await client.resolveDecision({
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
        bindingDigest: card.bindingDigest,
        choice: 'allow-once',
        expectedVersion: card.version,
      });
      expect(again.status).toBe('invalidated');
      expect(leases(root)).toEqual(baseline);
    } finally {
      client.close();
    }
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
    // Explicit restoration does not bypass the durable origin's bound marker.
    fs.rmSync(join(profile, 'restore-guard.json'));
    expect(() => createRuntime({ dbPath: join(profile, 'runtime.sqlite') })).toThrow(
      'restore_restricted',
    );
    await expect(startLocalRuntime({ profile, restore: true, provider: null })).rejects.toThrow(
      'restore_restricted',
    );
  } finally {
    if (host) {
      const stopped = await host.stop();
      if (stopped.outcome === 'complete') await host.closed;
    }
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
