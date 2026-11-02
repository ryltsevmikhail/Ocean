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
