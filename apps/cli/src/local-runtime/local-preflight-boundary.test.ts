import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  DirectChatService,
  type ConversationStore,
  type ConversationTransaction,
} from '@runnets/application';
import { preflightFixture } from '../../test-fixtures/local-preflight.js';

type Evidence = NonNullable<ConversationTransaction['chatFailureEvidence']>;
it.each([
  'absent',
  'null',
  'throw',
  'stale-head',
  'string-head',
  'missing-count',
  'negative-count',
  'NaN-count',
] as const)(
  'keeps an otherwise proven failure uncertain with %s transactional evidence',
  async (control) => {
    const f = preflightFixture();
    try {
      const store: ConversationStore = {
        atomic: (work) =>
          f.store.conversations.atomic((tx) => {
            const { chatFailureEvidence: inspect, ...rest } = tx;
            if (control === 'absent') return work(rest);
            const evidence: Evidence = (id) => {
              if (control === 'throw') throw Error('unreadable');
              if (control === 'null') return null;
              const current = inspect!(id)!;
              if (control === 'stale-head')
                return { ...current, taskVersion: current.taskVersion - 1 };
              if (control === 'string-head')
                return { ...current, taskVersion: String(current.taskVersion) } as never;
              if (control === 'missing-count') return { taskVersion: current.taskVersion } as never;
              return { ...current, relatedPendingEffects: control === 'negative-count' ? -1 : NaN };
            };
            return work({ ...tx, chatFailureEvidence: evidence });
          }),
      };
      const chat = new DirectChatService({
        store,
        tasks: f.tasks,
        reviews: f.reviews,
        clock: f.clock,
        nextId: f.nextId,
      });
      const result = await chat.send(f.input);
      if (!result.ok || !('id' in result.value)) throw Error('fixture turn');
      const turn = result.value;
      expect(turn.status).toBe('uncertain');
      await chat.recover();
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(turn.id)?.status)).toBe('uncertain');
    } finally {
      f.close();
    }
  },
);

it('holds the same SQLite write lock across current evidence and failed publication', async () => {
  const f = preflightFixture();
  const competitor = new DatabaseSync(f.path);
  competitor.exec('PRAGMA busy_timeout=0');
  let reads = 0,
    guardedWrites = 0;
  const blocked = () =>
    expect(() =>
      competitor.exec("INSERT INTO tool_invocations_v1 VALUES ('competitor','plugin','uncertain')"),
    ).toThrow(/locked/);
  const store: ConversationStore = {
    atomic: (work) =>
      f.store.conversations.atomic((tx) =>
        work({
          ...tx,
          chatFailureEvidence: (id) => {
            const evidence = tx.chatFailureEvidence!(id);
            reads++;
            blocked();
            return evidence;
          },
          putChatTurn: (turn) => {
            if (turn.status === 'failed') {
              guardedWrites++;
              expect(reads).toBe(1);
              blocked();
            }
            tx.putChatTurn(turn);
          },
        }),
      ),
  };
  try {
    const chat = new DirectChatService({
      store,
      tasks: f.tasks,
      reviews: f.reviews,
      clock: f.clock,
      nextId: f.nextId,
    });
    const result = await chat.send(f.input);
    expect(result.ok && result.value.status).toBe('failed');
    expect(reads).toBe(1);
    expect(guardedWrites).toBe(1);
    expect(await f.store.tools.pending()).toEqual([]);
  } finally {
    competitor.close();
    f.close();
  }
});

it('refuses an escaped evidence inspector outside its conversation transaction', () => {
  const f = preflightFixture();
  try {
    const inspect = f.store.conversations.atomic((tx) => tx.chatFailureEvidence!);
    expect(inspect('tr_absent')).toBeNull();
  } finally {
    f.close();
  }
});
