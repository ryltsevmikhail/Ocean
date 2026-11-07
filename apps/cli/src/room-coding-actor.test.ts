import { expect, it } from 'vitest';
import { canonicalJson } from '@runnets/domain';
import { setup, settledRead } from '../test-fixtures/room-coding.js';
it('refuses an actual SQL read claim naming the dev from an unassigned peer run', async () => {
  const f = setup('autonomous', true, true);
  try {
    const r = await settledRead(f, false);
    if (f.claim.kind !== 'claimed') throw Error('claim');
    expect(f.claim.turn.bot.id).toBe('peer');
    expect(f.claim.turn.codingTaskId).toBeUndefined();
    const args = { path: 'README.md' },
      request = {
        workspaceId: 'ws_room',
        roomId: 'room',
        botId: 'dev',
        taskId: f.b.id,
        projectRoot: f.b.projectRoot,
        worktreeRoot: f.b.worktreeRoot!,
        runId: r.context.taskRunId,
        attemptId: r.context.attemptId,
        invocationId: r.call.id,
        tool: 'read_file' as const,
        arguments: args,
        operationDigest: f.approvals.deps.store.atomic((tx) =>
          tx.projectId!(canonicalJson(['read_file', args])),
        ),
      };
    const { codingReadAdmission } = await import('@runnets/application');
    const claimed = f.store.codingApprovals.atomic((tx) => {
      const p = codingReadAdmission(tx, request, f.deps.clock.now().getTime());
      return !!p && tx.claimRead!(request, p.preview.effect, f.deps.clock.now().getTime());
    });
    expect(claimed).toBe(false);
    const mutation = {
      ...f.operation('write').binding,
      workspaceId: request.workspaceId,
      roomId: request.roomId,
      botId: request.botId,
      taskId: request.taskId,
      projectRoot: request.projectRoot,
      worktreeRoot: request.worktreeRoot,
      runId: request.runId,
      attemptId: request.attemptId,
      invocationId: request.invocationId,
    };
    expect(f.approvals.request('peer-mutation', mutation, 'exact edit', true)).toMatchObject({
      ok: false,
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM ocean_coding_approvals').get()?.['n']).toBe(0);

    expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  } finally {
    f.close();
  }
});
