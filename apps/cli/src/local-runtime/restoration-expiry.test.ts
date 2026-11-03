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

/** The real default coordination registry under the synthetic HOME, never the user one. */
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

/** One real source-deleted format-2 maintenance profile (same public backup/restore path). */
async function restoredProfile(root: string) {
  const f = await codingWorkflowFixture('direct');
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
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'expired restored marker\n');
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
    return { f, selected, profile, task };
  } catch (error) {
    f.close();
    throw error;
  }
}

it('refuses a rebind preview that expires on the real maintenance host and publishes nothing', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'restore-expiry-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const { f, selected, profile, task } = await restoredProfile(root);
  let host: LocalRuntimeHost | undefined;
  const clients: LocalRuntimeClient[] = [];
  try {
    const registration = join(profile, 'coding-projects.json');
    // Restore keeps the archived configuration metadata; only materialization writes the
    // live registration, so its absence is a product-path effect witness.
    expect(fs.existsSync(registration)).toBe(false);
    const baseline = leases(root);
    expect(baseline).toHaveLength(2);
    // Deterministic test-only clock seam; production callers omit it and get Date.now.
    let now = Date.now();
    host = await startLocalRuntime({ profile, restore: true, provider: null, now: () => now });
    const a = await connectLocalRuntime({ profile }),
      b = await connectLocalRuntime({ profile });
    clients.push(a, b);
    const inspection = await a.inspectRestore({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: task.id,
      requestId: 'expiry-rebind',
      projectRoot: selected,
      policy: task.policy,
    });
    const selection = inspection.selection;
    const card = await a.previewRestore(selection);
    expect(card).toMatchObject({ kind: 'restore-rebind', status: 'pending', version: 1 });
    const createdAt = card.createdAt,
      expiresAt = card.expiresAt;
    expect(createdAt).toBe(now);
    expect(expiresAt).toBe(createdAt + 300000);
    // A second client sees the same pending card before the deadline.
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    };
    expect((await b.getDecision(ref)).status).toBe('pending');
    const preview = await a.restoreResult(selection);
    expect(preview.state).toBe('preview');
    expect(preview.successorTaskId).toBeTruthy();
    // Advance exactly past the five-minute deadline; no wall-clock wait.
    now = expiresAt + 1;
    // The second client attempts the stale allow-once owner decision after expiry.
    const resolved = await b.resolveDecision({
      ...ref,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
      expectedVersion: card.version,
    });
    expect(resolved.status).toBe('expired');
    expect(resolved.version).not.toBe(1);
    const expired = await b.getDecision(ref);
    expect(expired.status).toBe('expired');
    const terminal = (async () => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const result = await a.restoreResult(selection);
        if (['ready', 'held', 'refused'].includes(result.state) || Date.now() > deadline)
          return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const refused = await terminal;
    expect(refused.state, refused.reason ?? '').toBe('refused');
    expect(refused.reason).toBe('expired');
    expect(refused.successorTaskId).toBe(preview.successorTaskId);
    expect(fs.existsSync(registration)).toBe(false);
    expect(fs.readdirSync(profile).filter((name) => name.startsWith('rebind-'))).toEqual([]);
    expect(leases(root)).toEqual(baseline);
    // Re-presenting the old request returns the settled card; it cannot restart authority.
    expect((await a.previewRestore(selection)).status).toBe('expired');
    const replay = await b.resolveDecision({
      ...ref,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
      expectedVersion: card.version,
    });
    expect(replay.status).toBe('expired');
    expect(await a.restoreResult(selection)).toEqual(refused);
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;

    // Durable record after the process-side close: refused/expired, no effect identity.
    const database = join(profile, 'runtime.sqlite');
    const store = openSqliteStore({ path: database });
    try {
      const record = store.rebind.atomic((tx) => tx.record(selection.requestId));
      expect(record).toMatchObject({
        requestId: selection.requestId,
        state: 'refused',
        reason: 'expired',
        revision: 2,
        createdAt,
        expiresAt,
        decisionId: card.decisionId,
        bindingDigest: card.bindingDigest,
        projectLease: null,
        worktreeLease: null,
        result: null,
      });
      expect(record!.preview.successorTaskId).toBe(preview.successorTaskId);
      expect(store.rebind.active()).toBeNull();
      expect(store.coding.atomic((tx) => tx.task(preview.successorTaskId))).toBeNull();
      expect(store.coding.atomic((tx) => tx.worktree(preview.successorTaskId))).toBeNull();
      const decision = store.ownerDecisions.find(ref);
      expect(decision).toMatchObject({
        kind: 'restore-rebind',
        status: 'expired',
        version: 2,
        createdAt: card.createdAt,
        expiresAt: card.expiresAt,
        bindingDigest: card.bindingDigest,
      });
      expect(decision!.status).not.toBe('allowed');
      expect(readCodingBackupInventory(database).tasks.map((t) => t.id)).toEqual([task.id]);
    } finally {
      store.close();
    }
    const raw = new DatabaseSync(database, { readOnly: true });
    try {
      expect(
        (raw.prepare('SELECT count(*) AS n FROM ocean_execution_epoch').get() as { n: number }).n,
      ).toBe(0);
    } finally {
      raw.close();
    }

    // A fresh production-composition restart still serves only the durable refusal.
    host = await startLocalRuntime({ profile, restore: true, provider: null });
    const c = await connectLocalRuntime({ profile });
    clients.push(c);
    expect(await c.restoreResult(selection)).toEqual(refused);
    expect(
      (
        await c.resolveDecision({
          ...ref,
          bindingDigest: card.bindingDigest,
          choice: 'allow-once',
          expectedVersion: card.version,
        })
      ).status,
    ).toBe('expired');
    expect(await c.restoreResult(selection)).toEqual(refused);
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
  } finally {
    for (const client of clients) client.close();
    if (host) {
      const stopped = await host.stop();
      if (stopped.outcome === 'complete') await host.closed;
    }
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30000);
