import type { ChatReview } from '@runnets/domain';
import { expect, it } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import * as memory from '@runnets/store';
import type { OwnerDecision, OwnerDecisionStore } from '@runnets/application';

it.each(['memory', 'sqlite'])(
  '%s persists a single scoped version winner, leaves evidence immutable and retires orphan requests',
  (backend) => {
    const sql = openSqliteStore({ path: ':memory:' });
    try {
      expect(
        backend === 'memory' ? 'InMemoryOwnerDecisions' in memory : 'ownerDecisions' in sql,
      ).toBe(true);
      const store: OwnerDecisionStore =
        backend === 'memory' ? new memory.InMemoryOwnerDecisions() : sql.ownerDecisions;
      const card: OwnerDecision = {
        workspaceId: 'w',
        roomId: 'r',
        runId: 'run',
        decisionId: 'id',
        kind: 'write',
        bindingDigest: 'a'.repeat(64),
        createdAt: 5,
        expiresAt: 300005,
        version: 1,
        status: 'pending',
        previewLength: 5,
      };
      expect(() => store.insert({ ...card, status: 'allowed', version: 2 }, 'exact')).toThrow();
      expect(() => store.insert(card, 'truncated')).toThrow();
      store.insert(card, 'exact');
      expect(store.find({ ...card, roomId: 'wrong' })).toBeNull();
      expect(store.list({ ...card, roomId: 'wrong' }, '', 1)).toEqual([]);
      expect(store.preview(card)).toBe('exact');
      expect(store.settle(card, 'allowed')).toBe(true);
      expect(store.settle(card, 'denied')).toBe(false);
      expect(store.find(card)).toEqual({ ...card, status: 'allowed', version: 2 });
      store.insert({ ...card, decisionId: 'other' }, 'exact');
      store.retirePending();
      store.retirePending();
      expect(store.list(card, 'id', 1)).toEqual([
        { ...card, decisionId: 'other', status: 'interrupted', version: 2 },
      ]);
      expect(store.preview(card)).toBe('exact');
    } finally {
      sql.close();
    }
  },
);

it.each(['memory', 'sqlite'])(
  '%s reads bounded UTF-16 preview pieces across an astral character',
  (backend) => {
    const sql = openSqliteStore({ path: ':memory:' });
    try {
      const store: OwnerDecisionStore =
        backend === 'memory' ? new memory.InMemoryOwnerDecisions() : sql.ownerDecisions;
      const card: OwnerDecision = {
        workspaceId: 'w',
        roomId: 'r',
        runId: 'run',
        decisionId: 'id',
        kind: 'write',
        bindingDigest: 'a'.repeat(64),
        createdAt: 5,
        expiresAt: 300005,
        version: 1,
        status: 'pending',
        previewLength: 4,
      };
      store.insert(card, 'a🌊b');
      expect(store.preview(card, 1, 1)).toBe('\ud83c');
      expect(store.preview(card, 2, 1)).toBe('\udf0a');
    } finally {
      sql.close();
    }
  },
);

it.each(['memory', 'sqlite'])(
  '%s permits only a matching review reservation promotion',
  (backend) => {
    const sql = openSqliteStore({ path: ':memory:' }),
      store = backend === 'memory' ? new memory.InMemoryConversationStore() : sql.conversations;
    const workspaceId = 'w',
      roomId = 'r',
      taskRunId = 'run',
      reservation = {
        kind: 'review_request' as const,
        data: { workspaceId, roomId, taskRunId, id: 'decision' },
      };
    try {
      store.atomic((tx) => tx.putReceipt('request', { binding: 'exact', reply: reservation }));
      expect(() =>
        store.atomic((tx) =>
          tx.putReceipt('request', { binding: 'different', reply: reservation }),
        ),
      ).toThrow();
      const review: ChatReview = {
        workspaceId,
        roomId,
        taskRunId,
        id: 'ack',
        reason: 'inspected',
        mode: 'text_only',
        actor: 'owner',
        turnId: 'turn',
        noticeMessageId: 'notice',
        observedVersion: 'seen',
        createdAt: 'now',
      };
      for (const [id, binding, scope] of [
        ['other', 'exact', roomId],
        ['decision', 'different', roomId],
        ['decision', 'exact', 'other'],
      ] as const) {
        expect(() =>
          store.atomic((tx) =>
            tx.completeReviewRequest('request', id, binding, { ...review, roomId: scope }),
          ),
        ).toThrow('request_conflict');
      }
      store.atomic((tx) => tx.completeReviewRequest('request', 'decision', 'exact', review));
      expect(store.atomic((tx) => tx.receipt('request'))).toEqual({
        binding: 'exact',
        reply: { kind: 'review', data: review },
      });
      expect(() =>
        store.atomic((tx) => tx.completeReviewRequest('request', 'decision', 'exact', review)),
      ).toThrow('request_conflict');
    } finally {
      sql.close();
    }
  },
);
