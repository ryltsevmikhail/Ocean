import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import {
  CodingFinalizationService,
  RuntimeOwnerDecisions,
  type ProviderPort,
} from '@runnets/application';
import { SqliteProjectLeases } from '@runnets/tools-node';
import { codingWorkflowFixture, faultyMath, repairedMath } from './coding-workflow-fixture.js';
import { worktreeBytesHash } from '../../test-fixtures/coding-finalization-fixture.js';
function provider(content: string, test: boolean): ProviderPort {
  let index = 0;
  const calls = [
    { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' },
    { id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'math.cjs', content }) },
    ...(test ? [{ id: 'test', name: 'run_test', arguments: '{"presetId":"test"}' }] : []),
  ];
  return {
    id: 'fixture',
    models: ['fixture'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream() {
      const call = calls[index++];
      if (call) yield { type: 'tool_call', call };
      else yield { type: 'text_delta', text: 'real tool results received' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield {
        type: 'completed',
        stopReason: call ? 'tool_calls' : 'stop',
        rawStopReason: call ? 'tool_calls' : 'stop',
      };
    },
  };
}
const itNative = it.runIf(
  process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1',
);
itNative(
  'finalizes real writes and failed/passed cleaned tests without reviving historical claims',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'ocean-finalize-used-home-'));
    vi.stubEnv('HOME', home);
    const f = await codingWorkflowFixture('direct').catch((error: unknown) => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      throw error;
    });
    const leases = new SqliteProjectLeases();
    let successor: Parameters<SqliteProjectLeases['release']>[0] | undefined;
    let service: CodingFinalizationService | undefined;
    try {
      expect(await f.send('deny', provider(faultyMath, false))).toMatchObject({ ok: true });
      expect(await f.send('failed', provider(faultyMath, true))).toMatchObject({ ok: true });
      expect(await f.send('passed', provider(repairedMath, true))).toMatchObject({ ok: true });
      // A later real edit changes today's tree after both historical tests cleaned up.
      expect(
        await f.send('later', provider(repairedMath + '// later tree\n', false)),
      ).toMatchObject({ ok: true });
      const evidence = f.runtime.codingEvidence!.list('task');
      expect(evidence).toMatchObject([
        { exitCode: 1, cleanupConfirmed: true },
        { exitCode: 0, cleanupConfirmed: true },
      ]);
      const changeset = await f.capture('final');
      expect(evidence[1]!.afterTreeHash).not.toBe(changeset.afterTreeHash);
      expect(f.runtime.finalization!.atomic((tx) => tx.holds('task'))).toEqual([]);
      const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
      const rows = () =>
        Object.fromEntries(
          [
            'ocean_coding_approvals',
            'ocean_coding_approval_claims',
            'tool_invocations_v2',
            'ocean_coding_test_evidence',
            'ocean_changesets',
            'ocean_worktrees',
            'ocean_messages',
            'events',
          ].map((table) => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]),
        );
      try {
        const before = rows(),
          tree = worktreeBytesHash(f.worktree);
        const task = f.runtime.coding.inspect('ws_ocean', 'task');
        if (!task.ok) throw Error(task.error.code);
        const approval = JSON.parse(
          String(
            db
              .prepare(
                "SELECT payload FROM ocean_coding_approvals WHERE json_extract(payload,'$.status')='consumed' LIMIT 1",
              )
              .get()?.['payload'],
          ),
        ) as { id: string; binding: Parameters<typeof f.runtime.codingApprovals.consume>[1] };
        const owner = new RuntimeOwnerDecisions(f.runtime.ownerDecisions, Date.now);
        service = new CodingFinalizationService({
          store: f.runtime.finalization!,
          owner,
          leases,
          ownerId: f.runtime.ownerId!,
          epochId: null,
          restored: false,
          clock: { now: () => new Date() },
          nextId: randomUUID,
          digest: (text) => createHash('sha256').update(text).digest('hex'),
        });
        const selection = {
          workspaceId: 'ws_ocean',
          roomId: f.room,
          taskId: 'task',
          requestId: 'finish-used',
        };
        const card = await service.preview(selection, new AbortController().signal);
        await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
        await service.join();
        expect(service.result(selection)).toMatchObject({
          state: 'finalized',
          release: { state: 'released', receipt: { operationId: 'finish-used' } },
        });
        expect(leases.releaseReceipt('finish-used')?.tokenHash).toBe(
          createHash('sha256').update(task.value.lease.token).digest('hex'),
        );
        expect(rows()).toEqual(before);
        expect(worktreeBytesHash(f.worktree)).toBe(tree);
        expect(f.runtime.codingApprovals.consume(approval.id, approval.binding).ok).toBe(false);
        await expect(
          service.preview(
            { ...selection, requestId: 'second-release' },
            new AbortController().signal,
          ),
        ).rejects.toThrow('finalization_already_disabled');
        let confirmed = false;
        const next = await f.runtime.coding.start(
          {
            workspaceId: 'ws_ocean',
            taskId: 'successor',
            requestId: 'next',
            projectRoot: f.project,
            ownerRoomId: f.room,
            devBotId: task.value.devBotId,
            reviewRoomId: task.value.reviewRoomId,
            reviewBotId: task.value.reviewBotId,
            devCapabilities: ['project_read'],
            testPresets: [],
          },
          {
            confirm: async () => {
              confirmed = true;
              return true;
            },
          },
        );
        expect(confirmed).toBe(true);
        expect(next).toMatchObject({ ok: true, value: { status: 'reserved' } });
        if (next.ok) successor = next.value.lease;
      } finally {
        db.close();
      }
    } finally {
      await service?.close();
      if (successor) leases.release(successor);
      f.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
  60000,
);
