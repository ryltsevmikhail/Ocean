import { expect, it, vi } from 'vitest';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  preparedFinalizationTask,
  leaseRegistryRows,
  worktreeBytesHash,
} from '../../test-fixtures/coding-finalization-fixture.js';
it('finalizes two independent profiles using the same request id through one real registry', async () => {
  const first = await preparedFinalizationTask();
  const second = await preparedFinalizationTask(first.home);
  const trees = [first, second].map((f) => worktreeBytesHash(f.worktree));
  try {
    const results = [];
    for (const f of [first, second]) {
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
          requestId: 'finish-used',
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
        const result = await vi.waitFor(
          async () => {
            const value = await client.finalizationResult(selection);
            if (value.state !== 'finalized' && value.state !== 'uncertain') throw Error('pending');
            return value;
          },
          { timeout: 15000 },
        );
        results.push({ result, digest: card.bindingDigest });
      } finally {
        client.close();
        await host.stop();
      }
    }
    expect(results.map((v) => v.result.state)).toEqual(['finalized', 'finalized']);
    expect(first.task.lease.ownerId).not.toBe(second.task.lease.ownerId);
    expect(results[0]!.result.release.receipt?.operationId).not.toBe(
      results[1]!.result.release.receipt?.operationId,
    );
    for (const value of results) {
      expect(value.result.requestId).toBe('finish-used');
      expect(value.result.release.receipt?.operationId).toBe('ocean-finalize-v2-' + value.digest);
    }
    const registry = leaseRegistryRows(first.registryPath);
    expect(registry.receipts).toHaveLength(2);
    expect(registry.leases).toHaveLength(2);
    expect([first, second].map((f) => worktreeBytesHash(f.worktree))).toEqual(trees);
  } finally {
    second.close();
    first.close();
  }
}, 60000);
