import { afterEach, expect, it } from 'vitest';
import type { ChatTurn } from '@runnets/domain';
import { consumerFixture } from '../test-fixtures/coding-consumer.js';
import { consumerFinalization } from '../test-fixtures/coding-consumer-finalization.js';
const fixtures: ReturnType<typeof consumerFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const setup = () => {
  const f = consumerFixture();
  fixtures.push(f);
  return f;
};
it.each(['provider', 'approval', 'review', 'worktree', 'project-lease', 'worktree-lease'] as const)(
  'retains B own %s refusal when A is disjoint',
  async (kind) => {
    const f = setup();
    await f.uncertainA();
    const a = f.aRows();
    if (kind === 'provider') {
      const turn: ChatTurn = {
        id: 'turn-b',
        codingTaskId: f.b.id,
        workspaceId: 'ws',
        roomId: 'room',
        requestId: 'request-b',
        taskRunId: 'provider-b',
        inboundMessageId: 'inbound',
        readThroughSeq: 0,
        bot: f.store.conversations.atomic((tx) => tx.bot('dev'))!,
        status: 'dispatching',
        text: 'work',
        preparedVersion: null,
        stopReason: 'end_turn',
      };
      f.store.conversations.atomic((tx) => tx.putChatTurn(turn));
    }
    if (kind === 'approval') {
      const { id, binding } = f.operation('write');
      expect(
        f.approvals.request(
          id,
          {
            ...binding,
            taskId: f.b.id,
            projectRoot: f.b.projectRoot,
            worktreeRoot: f.b.worktreeRoot!,
          },
          'edit',
          true,
        ).ok,
      ).toBe(true);
    }
    if (kind === 'review')
      f.db
        .prepare('INSERT INTO ocean_coding_review_requests VALUES(?,?)')
        .run(
          'review-b',
          JSON.stringify({ id: 'review-b', binding: { taskId: f.b.id }, status: 'requested' }),
        );
    if (kind === 'worktree') {
      const worktree = f.store.coding.atomic((tx) => tx.worktree(f.b.id))!;
      f.db
        .prepare('UPDATE ocean_worktrees SET state=?,payload=? WHERE task_id=?')
        .run('uncertain', JSON.stringify({ ...worktree, state: 'uncertain' }), f.b.id);
    }
    if (kind === 'project-lease') f.live.delete('token-b');
    if (kind === 'worktree-lease') f.live.delete('worktree-b');
    const { service, selection, released } = consumerFinalization(f);
    try {
      await expect(service.preview(selection, new AbortController().signal)).rejects.toThrow();
      expect(released).toEqual([]);
      expect(f.aRows()).toEqual(a);
      expect(f.store.coding.atomic((tx) => tx.task(f.b.id))?.status).toBe('reserved');
    } finally {
      await service.close();
    }
  },
);
it('invalidates finalization after a late conflict during the owner await without releasing either task', async () => {
  const f = setup();
  await f.uncertainA();
  const a = f.aRows();
  const { owner, service, selection, released } = consumerFinalization(f);
  try {
    const card = await service.preview(selection, new AbortController().signal);
    f.db.exec("INSERT INTO tool_invocations_v1 VALUES('late','command','uncertain')");
    expect(await owner.resolve(card, card.bindingDigest, card.version, 'allow-once')).toMatchObject(
      { status: 'invalidated' },
    );
    await service.join();
    expect(service.result(selection)).toMatchObject({ state: 'refused', taskStatus: 'reserved' });
    expect(released).toEqual([]);
    expect(f.aRows()).toEqual(a);
  } finally {
    await service.close();
  }
});
