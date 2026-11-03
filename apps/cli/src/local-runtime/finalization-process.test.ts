import { expect, it, vi } from 'vitest';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
  sha256,
  worktreeBytesHash,
} from '../ocean/coding-finalization-fixture.js';
import type { CodingAccess } from '@runnets/domain';
const taskOf = (rows: readonly string[]) => JSON.parse(rows[0]!) as Record<string, unknown>;
const successorInput = (
  f: Awaited<ReturnType<typeof preparedFinalizationTask>>,
  requestId = 'start2',
) => ({
  workspaceId: 'ws_ocean',
  taskId: 'task2',
  requestId,
  projectRoot: f.project,
  ownerRoomId: f.room,
  devBotId: f.task.devBotId,
  reviewRoomId: f.task.reviewRoomId,
  reviewBotId: f.task.reviewBotId,
  devCapabilities: ['project_read'] as const,
  testPresets: [],
});
it('finalizes a genuinely prepared task and admits only one separately confirmed successor', async () => {
  const f = await preparedFinalizationTask();
  const before = codingRows(f.db, 'task'),
    tree = worktreeBytesHash(f.worktree);
  try {
    // The exact live project lease refuses a second task before finalization.
    const early = createRuntime({ dbPath: f.db, codingWorktreeDirectory: f.worktreeBase });
    try {
      await early.ready;
      expect(
        await early.coding.start(successorInput(f), { confirm: () => Promise.resolve(true) }),
      ).toMatchObject({ ok: false, error: { code: 'project_busy' } });
    } finally {
      early.close();
    }
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
        requestId: 'finalize-1',
      };
      const card = await client.previewFinalization(selection);
      expect(card).toMatchObject({ kind: 'task-finalization', status: 'pending', version: 1 });
      const preview = JSON.parse(
        await client.decisionPreview({
          workspaceId: card.workspaceId,
          roomId: card.roomId,
          runId: card.runId,
          decisionId: card.decisionId,
        }),
      ) as { binding: { assets: Record<string, unknown> }; retained: string[] };
      expect(preview.binding.assets).toMatchObject({
        changesets: [f.changeset.hash],
        reviews: ['review-1'],
        evidence: [f.evidence.hash],
      });
      expect(preview.retained).toContain('worktree-bytes');
      await client.resolveDecision({
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
        bindingDigest: card.bindingDigest,
        expectedVersion: card.version,
        choice: 'deny',
      });
      await vi.waitFor(
        async () => expect((await client.finalizationResult(selection)).state).toBe('refused'),
        { timeout: 10000 },
      );
      expect(leaseRegistryRows(f.registryPath).leases).toHaveLength(2);
      const second = { ...selection, requestId: 'finalize-2' };
      const allow = await client.previewFinalization(second);
      await client.resolveDecision({
        workspaceId: allow.workspaceId,
        roomId: allow.roomId,
        runId: allow.runId,
        decisionId: allow.decisionId,
        bindingDigest: allow.bindingDigest,
        expectedVersion: allow.version,
        choice: 'allow-once',
      });
      const result = await vi.waitFor(
        async () => {
          const value = await client.finalizationResult(second);
          if (value.state !== 'finalized') throw Error('not finalized: ' + value.state);
          return value;
        },
        { timeout: 15000 },
      );
      expect(result).toMatchObject({ state: 'finalized', taskStatus: 'finalized' });
      expect(result.release).toMatchObject({
        state: 'released',
        outcome: 'released',
        receipt: {
          operationId: 'finalize-2',
          tokenHash: sha256(f.task.lease.token),
          bindingDigest: allow.bindingDigest,
        },
      });
      expect(worktreeBytesHash(f.worktree)).toBe(tree);
      const after = codingRows(f.db, 'task');
      // Only the controlled disabled status changes; every other task field,
      // worktree binding, policy and lease identity is byte-identical.
      expect({ ...taskOf(after.task), status: 'reserved' }).toEqual(taskOf(before.task));
      expect(taskOf(after.task)['status']).toBe('finalized');
      expect(after.changesets).toEqual(before.changesets);
      expect(after.reviews).toEqual(before.reviews);
      expect(after.verdicts).toEqual(before.verdicts);
      expect(after.evidence).toEqual(before.evidence);
      expect(after.finalization.map((row) => JSON.parse(row)['state'])).toEqual([
        'refused',
        'finalized',
      ]);
      const registry = leaseRegistryRows(f.registryPath);
      // Only the exact project reservation is released; the worktree lease and
      // every byte of the prepared tree stay intact.
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]?.['root']).toBe(f.worktree);
      expect(registry.receipts).toHaveLength(1);
      await expect(
        client.previewFinalization({ ...selection, requestId: 'finalize-late' }),
      ).rejects.toThrow('finalization_already_disabled');
    } finally {
      client.close();
      await host.stop();
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      const runtime = createRuntime({ dbPath: f.db, codingWorktreeDirectory: f.worktreeBase });
      try {
        await runtime.ready;
        const access: CodingAccess = {
          workspaceId: 'ws_ocean',
          taskId: 'task',
          roomId: f.room,
          botId: f.task.devBotId,
          policyVersion: 1,
          capability: 'project_read',
        };
        expect(runtime.coding.authorize(access)).toMatchObject({
          ok: false,
          error: { code: 'coding_denied' },
        });
        expect(
          await runtime.codingChanges.prepare(access, {
            confirm: () => {
              throw Error('must not confirm');
            },
          }),
        ).toMatchObject({ ok: false, error: { code: 'coding_denied' } });
        expect(
          await runtime.coding.cancel('ws_ocean', 'task', { confirm: async () => true }),
        ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
        expect(runtime.coding.inspect('ws_ocean', 'task')).toMatchObject({
          ok: true,
          value: { status: 'finalized' },
        });
        // Frozen historical diff/review evidence stays readable for the exact
        // participant while granting no executable capability.
        expect(runtime.codingChanges.history(access)).toEqual({
          ok: true,
          value: f.changeset,
        });
        expect(runtime.codingChanges.read(access, f.changeset.hash)).toEqual({
          ok: true,
          value: f.changeset,
        });
        if (reopen === 1) {
          expect(
            await runtime.coding.start(successorInput(f), {
              confirm: () => Promise.resolve(true),
            }),
          ).toMatchObject({ ok: true, value: { id: 'task2', status: 'reserved' } });
          expect({
            ...taskOf(codingRows(f.db, 'task').task),
            status: 'reserved',
          }).toEqual(taskOf(before.task));
        }
      } finally {
        runtime.close();
      }
    }
    const successor = leaseRegistryRows(f.registryPath);
    const projectLease = successor.leases.find((row) => row['root'] === f.project);
    expect(projectLease).toBeDefined();
    expect(String(projectLease?.['token'])).not.toBe(f.task.lease.token);
    expect(successor.receipts).toHaveLength(1);
  } finally {
    f.close();
  }
}, 60000);
