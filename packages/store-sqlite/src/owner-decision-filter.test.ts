import { expect, it } from 'vitest';
import { InMemoryOwnerDecisions } from '@runnets/store';
import { openSqliteStore } from './store.js';

it.each(['memory', 'sqlite'] as const)(
  'filters setup cards before %s page limits without dropping old rows',
  (kind) => {
    const db = kind === 'sqlite' ? openSqliteStore({ path: ':memory:' }) : null;
    const store = db?.ownerDecisions ?? new InMemoryOwnerDecisions();
    const scope = { workspaceId: 'ws', roomId: 'room' };
    try {
      for (const [decisionId, kind] of [
        ['a', 'project-setup'],
        ['b', 'write'],
        ['c', 'test'],
      ] as const)
        store.insert(
          {
            ...scope,
            runId: 'run',
            decisionId,
            kind,
            bindingDigest: 'a'.repeat(64),
            version: 1,
            status: 'pending',
            createdAt: 0,
            expiresAt: 300000,
            previewLength: 2,
          },
          '{}',
        );
      expect(store.list(scope, '', 1).map((c) => c.decisionId)).toEqual(['a']);
      expect(store.list(scope, '', 1, 'project-setup').map((c) => c.decisionId)).toEqual(['b']);
      expect(store.list(scope, 'b', 1, 'project-setup').map((c) => c.decisionId)).toEqual(['c']);
    } finally {
      db?.close();
    }
  },
);
