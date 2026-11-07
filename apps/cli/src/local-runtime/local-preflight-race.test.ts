import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { preflightFixture } from '../../test-fixtures/local-preflight.js';

it.each([
  { mode: 'live', effect: 'scoped' },
  { mode: 'recovery', effect: 'scoped' },
  { mode: 'live', effect: 'legacy' },
  { mode: 'recovery', effect: 'legacy' },
] as const)(
  'keeps $mode uncertain when a $effect claim commits after a valid review snapshot',
  async ({ mode, effect }) => {
    const f = preflightFixture();
    try {
      let id = '';
      if (mode === 'recovery') {
        const result = await f.chat.send(f.input);
        if (!result.ok || !('id' in result.value)) throw Error('fixture turn');
        const turn = result.value;
        id = turn.id;
        f.store.conversations.atomic((tx) => tx.putChatTurn({ ...turn, status: 'uncertain' }));
      }
      let inserted = false;
      const review = f.reviews.review.bind(f.reviews);
      f.reviews.review = async (workspace, run) => {
        const snapshot = await review(workspace, run);
        if (!snapshot.ok) throw Error('real review required');
        expect(snapshot.value.relatedPendingEffects).toBe(0);
        const state = await f.tasks.state(taskRunId(run));
        if (state.status !== 'failed' || state.activeAttempt === null) throw Error('failed run');
        if (effect === 'legacy') {
          f.legacyClaim();
          inserted = true;
        } else
          inserted = await f.store.tools.claim(
            'late',
            'plugin',
            { taskRunId: run, attemptId: state.activeAttempt.attemptId },
            'fixture',
          );
        return snapshot;
      };
      if (mode === 'live') {
        const result = await f.chat.send(f.input);
        if (!result.ok || !('id' in result.value)) throw Error('fixture turn');
        id = result.value.id;
      } else await f.chat.recover();
      expect(inserted).toBe(true);
      expect(await f.store.tools.pending()).toHaveLength(1);
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(id)?.status)).toBe('uncertain');
      expect(f.store.conversations.atomic((tx) => tx.activeChatTurn(f.input.roomId)?.id)).toBe(id);
      expect(f.http.requests.filter((r) => r.url.endsWith('/api/chat'))).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);

it.each(['live', 'recovery'] as const)(
  'preserves a changed %s turn phase after review',
  async (mode) => {
    const f = preflightFixture();
    try {
      let id = '';
      if (mode === 'recovery') {
        const result = await f.chat.send(f.input);
        if (!result.ok || !('id' in result.value)) throw Error('fixture turn');
        const turn = result.value;
        id = turn.id;
        f.store.conversations.atomic((tx) => tx.putChatTurn({ ...turn, status: 'uncertain' }));
      }
      const review = f.reviews.review.bind(f.reviews);
      const changed = mode === 'live' ? 'uncertain' : 'dispatching';
      f.reviews.review = async (workspace, run) => {
        const snapshot = await review(workspace, run);
        f.store.conversations.atomic((tx) => {
          const turn = tx.chatTurns().find((t) => t.taskRunId === run)!;
          id = turn.id;
          tx.putChatTurn({ ...turn, status: changed });
        });
        return snapshot;
      };
      if (mode === 'live')
        await expect(f.chat.send(f.input)).rejects.toThrow('chat phase conflict');
      else await f.chat.recover();
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(id)?.status)).toBe(changed);
    } finally {
      f.close();
    }
  },
);

it.each(['live', 'recovery'] as const)(
  'preserves a committed %s continuation review after the failure snapshot',
  async (mode) => {
    const f = preflightFixture();
    try {
      let id = '',
        continuation = '';
      if (mode === 'recovery') {
        const result = await f.chat.send(f.input);
        if (!result.ok || !('id' in result.value)) throw Error('fixture turn');
        const turn = result.value;
        id = turn.id;
        f.store.conversations.atomic((tx) => tx.putChatTurn({ ...turn, status: 'uncertain' }));
      }
      const review = f.reviews.review.bind(f.reviews);
      f.reviews.review = async (workspace, run) => {
        const snapshot = await review(workspace, run);
        f.reviews.review = review;
        f.store.conversations.atomic((tx) => {
          const turn = tx.chatTurns().find((t) => t.taskRunId === run)!;
          id = turn.id;
          tx.putChatTurn({ ...turn, status: 'uncertain' });
        });
        const current = await review(workspace, run);
        if (!current.ok) throw Error('current review');
        const receipt = await f.reviews.acknowledge(
          {
            workspaceId: workspace,
            taskRunId: run,
            requestId: 'late-review',
            reviewVersion: current.value.version,
            reason: 'fixture',
          },
          { confirm: async () => true },
          f.input.signal,
        );
        if (!receipt.ok) throw Error('acknowledgment');
        continuation = receipt.value.id;
        return snapshot;
      };
      if (mode === 'live')
        await expect(f.chat.send(f.input)).rejects.toThrow('chat phase conflict');
      else await f.chat.recover();
      const current = f.store.conversations.atomic((tx) => tx.chatTurn(id));
      expect(current?.status).toBe('uncertain');
      expect(current?.continuationReviewId).toBe(continuation);
      expect(continuation).not.toBe('');
    } finally {
      f.close();
    }
  },
);
