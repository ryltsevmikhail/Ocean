import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { SqliteProjectLeases } from '@runnets/tools-node';
import { CodingFinalizationService, RuntimeOwnerDecisions } from '@runnets/application';
import type { ProjectLease } from '@runnets/domain';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
} from '../../test-fixtures/coding-finalization-fixture.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function finalizeLive(
  f: Awaited<ReturnType<typeof preparedFinalizationTask>>,
  requestId: string,
) {
  const host = await startLocalRuntime({
    profile: f.profile,
    provider: null,
    codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  try {
    const selection = {
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: 'task',
      requestId,
    };
    const card = await client.previewFinalization(selection);
    await client.resolveDecision({
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
      bindingDigest: card.bindingDigest,
      expectedVersion: card.version,
      choice: 'allow-once',
    });
    return await vi.waitFor(
      async () => {
        const result = await client.finalizationResult(selection);
        if (result.state !== 'finalized') throw Error('not finalized: ' + result.state);
        return result;
      },
      { timeout: 15000 },
    );
  } finally {
    client.close();
    await host.stop();
  }
}
it('preserves finalized and uncertain state through source-deleted backup/restore and never releases a restored lease', async () => {
  const f = await preparedFinalizationTask();
  const archive = join(f.root, 'archive'),
    restored = join(f.root, 'restored');
  try {
    const result = await finalizeLive(f, 'finalize-backup');
    expect(result.state).toBe('finalized');
    const finalizedRows = codingRows(f.db, 'task');
    const registry = leaseRegistryRows(f.registryPath);
    await backupProfile(f.profile, archive, { managedDirectory: f.worktreeBase });
    rmSync(f.profile, { recursive: true, force: true });
    restoreProfile(archive, restored);
    rmSync(archive, { recursive: true, force: true });
    expect(existsSync(join(restored, 'restore-guard.json'))).toBe(true);
    const restoredRows = codingRows(join(restored, 'runtime.sqlite'), 'task');
    expect(restoredRows.task).toEqual(finalizedRows.task);
    expect(restoredRows.finalization).toEqual(finalizedRows.finalization);
    expect(restoredRows.changesets).toEqual(finalizedRows.changesets);
    expect(restoredRows.reviews).toEqual(finalizedRows.reviews);
    expect(restoredRows.evidence).toEqual(finalizedRows.evidence);
    // Ordinary restored admission and the public host both refuse; no lease moves.
    await expect(
      startLocalRuntime({
        profile: restored,
        provider: null,
        codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
      }),
    ).rejects.toThrow('restore_restricted');
    expect(leaseRegistryRows(f.registryPath)).toEqual(registry);
    // The restored profile cannot create a live finalization over the old lease.
    const store = openSqliteStore({ path: join(restored, 'runtime.sqlite') });
    try {
      const task = store.coding.atomic((tx) => tx.task('task'))!;
      const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
      const service = new CodingFinalizationService({
        store: store.finalization,
        leases: new SqliteProjectLeases(),
        owner,
        clock: { now: () => new Date() },
        ownerId: task.lease.ownerId,
        epochId: null,
        restored: true,
        nextId: () => 'decision-restored',
        digest,
      });
      await expect(
        service.preview(
          { workspaceId: 'ws_ocean', roomId: f.room, taskId: 'task', requestId: 'restored-1' },
          new AbortController().signal,
        ),
      ).rejects.toThrow('finalization_restricted');
    } finally {
      store.close();
    }
    expect(leaseRegistryRows(f.registryPath)).toEqual(registry);
  } finally {
    f.close();
  }
}, 60000);
it('keeps an uncertain finalizing intent inert across backup and source-deleted restore', async () => {
  const f = await preparedFinalizationTask();
  const archive = join(f.root, 'archive'),
    restored = join(f.root, 'restored'),
    otherRegistry = join(f.root, 'other-registry');
  mkdirSync(otherRegistry, { mode: 0o700 });
  try {
    const registry = leaseRegistryRows(f.registryPath);
    const store = openSqliteStore({ path: f.db });
    const real = new SqliteProjectLeases();
    const unreachable = {
      acquire: real.acquire.bind(real),
      owns: real.owns.bind(real),
      release: real.release.bind(real),
      identity: () => real.identity(),
      releaseExact: (lease: ProjectLease) => {
        void lease;
        return { outcome: 'registry_missing' as const, detail: 'absent' };
      },
      releaseReceipt: () => null,
    };
    const task = store.coding.atomic((tx) => tx.task('task'))!;
    const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
    const service = new CodingFinalizationService({
      store: store.finalization,
      leases: unreachable,
      owner,
      clock: { now: () => new Date() },
      ownerId: task.lease.ownerId,
      epochId: null,
      restored: false,
      nextId: () => 'decision-uncertain',
      digest,
    });
    const selection = {
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: 'task',
      requestId: 'finalize-uncertain',
    };
    const card = await service.preview(selection, new AbortController().signal);
    await owner.resolve(
      {
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
      },
      card.bindingDigest,
      card.version,
      'allow-once',
    );
    await service.join();
    const held = codingRows(f.db, 'task');
    expect(held.finalization.map((row) => JSON.parse(row)['state'])).toEqual(['uncertain']);
    expect(JSON.parse(held.task[0]!)['status']).toBe('finalizing');
    store.close();
    // The original exact reservation is still held: no unproven release happened.
    expect(leaseRegistryRows(f.registryPath)).toEqual(registry);
    await backupProfile(f.profile, archive, { managedDirectory: f.worktreeBase });
    rmSync(f.profile, { recursive: true, force: true });
    restoreProfile(archive, restored);
    rmSync(archive, { recursive: true, force: true });
    const restoredRows = codingRows(join(restored, 'runtime.sqlite'), 'task');
    expect(restoredRows.finalization).toEqual(held.finalization);
    expect(restoredRows.task).toEqual(held.task);
    await expect(
      startLocalRuntime({
        profile: restored,
        provider: null,
        codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
      }),
    ).rejects.toThrow('restore_restricted');
    expect(leaseRegistryRows(f.registryPath)).toEqual(registry);
    expect(existsSync(join(restored, 'restore-guard.json'))).toBe(true);
  } finally {
    f.close();
  }
}, 60000);
