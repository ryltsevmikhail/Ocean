import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
  worktreeBytesHash,
} from '../../test-fixtures/coding-finalization-fixture.js';
import { crashFinalization } from '../../test-fixtures/finalization-crash-worker.js';
import type { CodingAccess } from '@runnets/domain';
function state(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT payload FROM ocean_coding_finalizations WHERE request_id='finalize-crash'")
      .get();
    const task = db.prepare("SELECT status FROM ocean_coding_tasks WHERE id='task'").get();
    return {
      state: row ? (JSON.parse(String(row['payload'])) as { state: string }).state : null,
      task: task ? String(task['status']) : null,
    };
  } finally {
    db.close();
  }
}
it.each(['intent', 'registry_begin', 'registry_commit', 'result'])(
  'kills a real finalization at %s and two reopenings never retry an unknown release',
  async (phase) => {
    const f = await preparedFinalizationTask();
    const tree = worktreeBytesHash(f.worktree);
    const evidence = codingRows(f.db, 'task');
    try {
      await crashFinalization(f.db, phase);
      const after = state(f.db);
      const beforeReopen = leaseRegistryRows(f.registryPath);
      if (phase === 'intent' || phase === 'registry_begin') {
        expect(after).toEqual({ state: 'finalizing', task: 'finalizing' });
        expect(beforeReopen.leases).toHaveLength(2);
        expect(beforeReopen.receipts).toHaveLength(0);
      } else if (phase === 'registry_commit') {
        expect(after).toEqual({ state: 'finalizing', task: 'finalizing' });
        expect(beforeReopen.leases).toHaveLength(1);
        expect(beforeReopen.receipts).toHaveLength(1);
      } else {
        expect(after).toEqual({ state: 'finalized', task: 'finalized' });
        expect(beforeReopen.leases).toHaveLength(1);
        expect(beforeReopen.receipts).toHaveLength(1);
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
        } finally {
          runtime.close();
        }
        const registryNow = leaseRegistryRows(f.registryPath);
        expect(registryNow.receipts).toHaveLength(beforeReopen.receipts.length);
        expect(registryNow.leases).toHaveLength(
          phase === 'registry_commit' || phase === 'result' ? 1 : beforeReopen.leases.length,
        );
        if (phase === 'intent' || phase === 'registry_begin') {
          expect(state(f.db)).toEqual({ state: 'uncertain', task: 'finalizing' });
        } else if (phase === 'registry_commit') {
          const resolved = state(f.db);
          expect(resolved.task).toBe('finalized');
          expect(resolved.state).toBe('finalized');
        } else {
          expect(state(f.db)).toEqual({ state: 'finalized', task: 'finalized' });
        }
      }
      if (phase === 'intent' || phase === 'registry_begin') {
        // The public result path decodes the held record without retrying anything.
        const host = await startLocalRuntime({
          profile: f.profile,
          provider: null,
          codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
        });
        const client = await connectLocalRuntime({ profile: f.profile });
        try {
          const result = await client.finalizationResult({
            workspaceId: 'ws_ocean',
            roomId: f.room,
            taskId: 'task',
            requestId: 'finalize-crash',
          });
          expect(result).toMatchObject({
            state: 'uncertain',
            taskStatus: 'finalizing',
            release: { state: 'unproven', outcome: null, receipt: null },
          });
          // A held task keeps its exact frozen changeset readable over the public view.
          const frozen = await client.codingRead('coding.diff', {
            workspaceId: 'ws_ocean',
            id: 'task',
            roomId: f.room,
          });
          expect(frozen).toEqual({
            ...f.changeset,
            kind: 'frozen',
            tests: [
              {
                presetId: null,
                hash: f.evidence.hash,
                passed: true,
                afterTreeHash: f.evidence.afterTreeHash,
              },
            ],
            workspaceId: 'ws_ocean',
            roomId: f.room,
          });
        } finally {
          client.close();
          await host.stop();
        }
      }
      expect(worktreeBytesHash(f.worktree)).toBe(tree);
      expect(codingRows(f.db, 'task').changesets).toEqual(evidence.changesets);
      expect(codingRows(f.db, 'task').reviews).toEqual(evidence.reviews);
      expect(codingRows(f.db, 'task').evidence).toEqual(evidence.evidence);
    } finally {
      f.close();
    }
  },
  60000,
);
