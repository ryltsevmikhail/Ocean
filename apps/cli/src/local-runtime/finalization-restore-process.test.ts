import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import { registerCodingProject } from '../ocean/coding-projects.js';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
} from '../../test-fixtures/coding-finalization-fixture.js';
import { crashFinalization } from '../../test-fixtures/finalization-crash-worker.js';
function taskRows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT id,status,payload FROM ocean_coding_tasks ORDER BY id')
      .all()
      .map((row) => ({
        id: String(row['id']),
        status: String(row['status']),
        payload: String(row['payload']),
      }));
  } finally {
    db.close();
  }
}
/** A second genuinely prepared reservation so one profile can hold two operations. */
async function secondPreparedTask(
  f: Awaited<ReturnType<typeof preparedFinalizationTask>>,
): Promise<void> {
  const project = join(f.root, 'second-project');
  mkdirSync(project);
  writeFileSync(join(project, 'math.cjs'), 'module.exports=(a,b)=>a-b;\n');
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', project, ...args], {
      env: {
        ...process.env,
        HOME: process.env['HOME'],
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  // A profile binds one workspace root. Point it at the second genuine project
  // only while reserving that task, then restore the fixture binding.
  const bindWorkspaceRoot = (root: string) => {
    const db = new DatabaseSync(f.db);
    try {
      db.prepare("UPDATE ocean_workspace SET root=? WHERE id='ws_ocean'").run(root);
    } finally {
      db.close();
    }
  };
  bindWorkspaceRoot(project);
  const runtime = createRuntime({
    dbPath: f.db,
    codingWorktreeDirectory: f.worktreeBase,
    codingTools: {
      sandbox: f.sandbox,
      inspectSandbox: f.sandbox,
      owner: () => ({ decide: () => Promise.resolve('cancel' as const) }),
    },
  });
  try {
    await runtime.ready;
    const started = await runtime.coding.start(
      {
        workspaceId: 'ws_ocean',
        taskId: 'task-preview',
        requestId: 'start-preview',
        projectRoot: project,
        ownerRoomId: f.room,
        devBotId: f.task.devBotId,
        reviewRoomId: f.task.reviewRoomId,
        reviewBotId: f.task.reviewBotId,
        devCapabilities: ['project_read'],
        testPresets: [],
      },
      { confirm: () => Promise.resolve(true) },
    );
    if (!started.ok) throw Error(started.error.code);
    const prepared = await runtime.codingChanges.prepare(
      {
        workspaceId: 'ws_ocean',
        taskId: 'task-preview',
        roomId: f.room,
        botId: f.task.devBotId,
        policyVersion: 1,
        capability: 'project_read',
      },
      { confirm: () => Promise.resolve(true) },
    );
    if (!prepared.ok) throw Error(prepared.error.code);
  } finally {
    runtime.close();
    bindWorkspaceRoot(f.project);
  }
  // The backup dependency graph reconciles every task against the registered
  // project catalog, so the second genuine project must be registered too.
  await registerCodingProject(
    f.profile,
    { id: 'second', root: project, testPresets: [], mounts: [] },
    () => Promise.resolve(true),
  );
}
it('leaves preview and finalizing finalization records inert on a restored host', async () => {
  const f = await preparedFinalizationTask();
  const archive = join(f.root, 'archive'),
    restored = join(f.root, 'restored');
  try {
    await secondPreparedTask(f);
    // One durable live preview (SIGKILL before confirmation) and one interrupted
    // finalizing intent whose exact release receipt exists in the live registry.
    await crashFinalization(f.db, 'preview', {
      taskId: 'task-preview',
      requestId: 'finalize-preview',
    });
    await crashFinalization(f.db, 'registry_commit');
    const before = {
      previewed: codingRows(f.db, 'task-preview'),
      finalizing: codingRows(f.db, 'task'),
      tasks: taskRows(f.db),
      registry: leaseRegistryRows(f.registryPath),
    };
    expect(before.previewed.finalization.map((row) => JSON.parse(row)['state'] as string)).toEqual([
      'preview',
    ]);
    expect(before.finalizing.finalization.map((row) => JSON.parse(row)['state'] as string)).toEqual(
      ['finalizing'],
    );
    expect(before.registry.receipts).toHaveLength(1);
    await backupProfile(f.profile, archive, { managedDirectory: f.worktreeBase });
    rmSync(f.profile, { recursive: true, force: true });
    restoreProfile(archive, restored);
    rmSync(archive, { recursive: true, force: true });
    const restoredDb = join(restored, 'runtime.sqlite');
    expect({
      previewed: codingRows(restoredDb, 'task-preview'),
      finalizing: codingRows(restoredDb, 'task'),
      tasks: taskRows(restoredDb),
    }).toEqual({ previewed: before.previewed, finalizing: before.finalizing, tasks: before.tasks });
    for (let attempt = 0; attempt < 2; attempt++) {
      const host = await startLocalRuntime({ profile: restored, restore: true, provider: null });
      const client = await connectLocalRuntime({ profile: restored });
      try {
        expect(client.identity.capabilities).toContain('restore.maintenance');
        expect(client.identity.capabilities).not.toContain('coding.finalize.preview');
        await expect(
          client.previewFinalization({
            workspaceId: 'ws_ocean',
            roomId: f.room,
            taskId: 'task',
            requestId: 'restore-late',
          }),
        ).rejects.toThrow('restore_restricted');
      } finally {
        client.close();
        expect((await host.stop()).outcome).toBe('complete');
        await host.closed;
      }
      // The restored records stay byte-identical and the live registry is untouched.
      expect({
        previewed: codingRows(restoredDb, 'task-preview'),
        finalizing: codingRows(restoredDb, 'task'),
        tasks: taskRows(restoredDb),
      }).toEqual({
        previewed: before.previewed,
        finalizing: before.finalizing,
        tasks: before.tasks,
      });
      expect(leaseRegistryRows(f.registryPath)).toEqual(before.registry);
    }
  } finally {
    f.close();
  }
}, 120000);
