import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openSqliteStore, readCodingBackupInventory } from '@runnets/store-sqlite';
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

it('lets two racing clients establish exactly one binding from distinct previews', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'restore-race-'));
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
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'racing restored marker\n');
    await f.capture('race-marker');
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
    const inspection = await a.inspectRestore({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: task.id,
      requestId: 'race-a',
      projectRoot: selected,
      policy: task.policy,
    });
    const selection = inspection.selection;
    // Two distinct request ids create two durable previews, each with its own epoch.
    const cardA = await a.previewRestore(selection);
    const cardB = await b.previewRestore({ ...selection, requestId: 'race-b' });
    expect(cardA.decisionId).not.toBe(cardB.decisionId);
    await Promise.all([
      a.resolveDecision({
        workspaceId: cardA.workspaceId,
        roomId: cardA.roomId,
        runId: cardA.runId,
        decisionId: cardA.decisionId,
        bindingDigest: cardA.bindingDigest,
        choice: 'allow-once',
        expectedVersion: cardA.version,
      }),
      b.resolveDecision({
        workspaceId: cardB.workspaceId,
        roomId: cardB.roomId,
        runId: cardB.runId,
        decisionId: cardB.decisionId,
        bindingDigest: cardB.bindingDigest,
        choice: 'allow-once',
        expectedVersion: cardB.version,
      }),
    ]);
    const terminal = async (requestId: string) => {
      const sel = { ...selection, requestId };
      const deadline = Date.now() + 15000;
      for (;;) {
        const result = await a.restoreResult(sel);
        if (['ready', 'held', 'refused'].includes(result.state) || Date.now() > deadline)
          return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const results = await Promise.all([terminal('race-a'), terminal('race-b')]);
    const ready = results.filter((r) => r.state === 'ready');
    const refused = results.filter((r) => r.state === 'refused');
    expect(ready).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(ready[0]!.successorTaskId).toBeTruthy();
    expect(refused[0]!.successorTaskId).not.toBe(ready[0]!.successorTaskId);
    // Exactly one materialization and one project/worktree lease pair; no epoch for the loser.
    expect(fs.readdirSync(profile).filter((name) => name.startsWith('rebind-'))).toEqual([
      'rebind-' + ready[0]!.epochId,
    ]);
    const leases = (() => {
      const path = join(root, 'home', '.local/state/ocean-coordination/leases.sqlite');
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return db
          .prepare('SELECT root FROM project_leases_v1')
          .all()
          .map((r) => String(r['root']));
      } finally {
        db.close();
      }
    })();
    const winner = ready[0]!;
    expect(leases.filter((path) => path === selected)).toHaveLength(1);
    expect(leases.filter((path) => path.includes('rebind-' + winner.epochId))).toHaveLength(1);
    expect(
      leases.filter((path) => refused.some((r) => path.includes('rebind-' + r.epochId))),
    ).toHaveLength(0);
    // A further preview cannot start a second epoch while the ready head exists.
    await expect(a.previewRestore({ ...selection, requestId: 'race-c' })).rejects.toThrow(
      'rebind_in_progress',
    );
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
    const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
    try {
      expect(store.rebind.active()?.requestId).toBe(winner.requestId);
      // One successor task was published; the original task is still present.
      expect(readCodingBackupInventory(join(profile, 'runtime.sqlite')).tasks).toHaveLength(2);
      expect(store.coding.atomic((tx) => tx.task(winner.successorTaskId))).not.toBeNull();
      expect(store.coding.atomic((tx) => tx.task(refused[0]!.successorTaskId))).toBeNull();
    } finally {
      store.close();
    }
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
