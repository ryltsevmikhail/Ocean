import { afterEach, expect, it } from 'vitest';
import type { ChatTurn } from '@runnets/domain';
import { claimFixture } from '../test-fixtures/finalization-claims.js';
const fixtures: ReturnType<typeof claimFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const setup = () => {
  const f = claimFixture();
  fixtures.push(f);
  return f;
};
function turn(f: ReturnType<typeof claimFixture>, runId: string): ChatTurn {
  return {
    id: 'turn',
    codingTaskId: 'task',
    workspaceId: 'ws',
    roomId: 'room',
    requestId: 'request',
    taskRunId: runId,
    inboundMessageId: 'inbound',
    readThroughSeq: 0,
    bot: f.store.conversations.atomic((tx) => tx.bot('dev'))!,
    status: 'completed',
    text: 'done',
    preparedVersion: 1,
    stopReason: 'end_turn',
  };
}
it.each(['accepted', 'dispatching', 'prepared', 'uncertain'] as const)(
  'retains a real SQLite %s provider hold after all claims settle',
  async (status) => {
    const f = setup();
    await f.dispatch('write');
    expect(f.holds()).toEqual([]);
    const pendingTurn = { ...turn(f, 'provider-run'), status };
    f.store.conversations.atomic((tx) => tx.putChatTurn(pendingTurn));
    expect(f.holds()).toContainEqual({
      id: 'turn',
      kind: 'provider',
      outcome: status,
      scope: 'task',
    });
  },
);
it('retains pending approval, active review and non-ready worktree holds after settlement', async () => {
  const f = setup();
  const operation = await f.dispatch('write');
  expect(f.holds()).toEqual([]);
  const oldApproval = f.approval(operation.id);
  f.store.codingApprovals.atomic((tx) =>
    tx.putApproval({
      ...oldApproval,
      id: 'pending',
      binding: { ...operation.binding, invocationId: 'pending' },
      status: 'pending',
    }),
  );
  f.db
    .prepare('INSERT INTO ocean_coding_review_requests VALUES(?,?)')
    .run(
      'review',
      JSON.stringify({ id: 'review', binding: { taskId: 'task' }, status: 'dispatching' }),
    );
  const worktree = f.store.coding.atomic((tx) => tx.worktree('task'))!;
  f.db
    .prepare('UPDATE ocean_worktrees SET state=?,payload=? WHERE task_id=?')
    .run('uncertain', JSON.stringify({ ...worktree, state: 'uncertain' }), 'task');
  expect(f.holds()).toEqual(
    expect.arrayContaining([
      { id: 'pending', kind: 'approval', outcome: 'pending', scope: 'task' },
      { id: 'review', kind: 'review', outcome: 'unresolved', scope: 'task' },
      { id: 'task', kind: 'worktree', outcome: 'uncertain', scope: 'task' },
    ]),
  );
});
it.each(['v1', 'v2'] as const)('preserves a global unrelated %s effect hold', async (version) => {
  const f = setup();
  await f.dispatch('write');
  expect(f.holds()).toEqual([]);
  if (version === 'v1')
    f.db.exec("INSERT INTO tool_invocations_v1 VALUES('unknown','command','uncertain')");
  else
    f.db.exec(
      "INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome) VALUES('unknown','coding_apply','other','attempt','fingerprint','started')",
    );
  expect(f.holds()).toContainEqual(expect.objectContaining({ id: 'unknown', scope: 'global' }));
});
it.each(['workspaceId', 'roomId', 'codingTaskId', 'bot', 'status'])(
  'holds contradictory terminal-turn %s even with exact settled worker proof',
  async (field) => {
    const f = setup();
    const operation = await f.dispatch('write');
    const completedTurn = turn(f, operation.binding.runId);
    f.store.conversations.atomic((tx) => tx.putChatTurn(completedTurn));
    expect(f.holds()).toEqual([]);
    const changed = {
      ...turn(f, operation.binding.runId),
      [field]: field === 'bot' ? { id: 'wrong' } : 'wrong',
    };
    f.db.prepare('UPDATE ocean_chat_turns SET payload=?').run(JSON.stringify(changed));
    expect(f.holds()).toContainEqual(expect.objectContaining({ kind: 'claim' }));
  },
);
