import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { connectLocalRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';

it('uses one common owner decision across clients, then opens a verified ordinary epoch', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'restore-host-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const f = await codingWorkflowFixture('direct');
  let host: LocalRuntimeHost | undefined;
  const clients: LocalRuntimeClient[] = [];
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
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'restored host marker\n');
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
    const a = await connectLocalRuntime({ profile }),
      b = await connectLocalRuntime({ profile });
    clients.push(a, b);
    expect(a.identity.capabilities).toContain('restore.preview');
    const inspection = await a.inspectRestore({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: task.id,
      requestId: 'rebind-host',
      projectRoot: selected,
      policy: task.policy,
    });
    expect(inspection.observations[0]?.scope).toBe('selected-project-only');
    await expect(
      a.submit({
        workspaceId: 'ws_ocean',
        roomId: f.room,
        requestId: 'forbidden',
        text: 'no provider dispatch',
      }),
    ).rejects.toThrow('restore_restricted');
    const card = await a.previewRestore(inspection.selection);
    const text = await b.decisionPreview({
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    });
    expect(JSON.parse(text).originalTask.id).toBe(task.id);
    await b.resolveDecision({
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
      expectedVersion: card.version,
    });
    let result = await a.restoreResult(inspection.selection);
    const deadline = Date.now() + 10000;
    while (!['ready', 'held', 'refused'].includes(result.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await a.restoreResult(inspection.selection);
    }
    expect(result.state, result.reason ?? '').toBe('ready');
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
    host = await startLocalRuntime({ profile, provider: null });
    const c = await connectLocalRuntime({ profile }),
      d = await connectLocalRuntime({ profile });
    clients.push(c, d);
    expect((await c.status()).instanceId).toBe((await d.status()).instanceId);
    expect((await c.restoreResult(inspection.selection)).successorTaskId).toBe(
      result.successorTaskId,
    );
    expect(fs.existsSync(join(profile, 'restore-guard.json'))).toBe(true);
  } finally {
    for (const c of clients) c.close();
    if (host) {
      const stopped = await host.stop();
      if (stopped.outcome === 'complete') await host.closed;
    }
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
