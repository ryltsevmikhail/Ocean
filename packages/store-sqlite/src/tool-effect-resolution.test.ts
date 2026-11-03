import { withImmediateTransaction } from './transaction.js';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SqliteToolJournal } from './tool-journal.js';
it('releases only the exact owner-reconciled apply hold while retaining uncertain history and replay protection', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new SqliteToolJournal(db),
      context = { taskRunId: 'apply-one', attemptId: 'apply' };
    expect(await journal.claim('one', 'coding_apply', context, 'exact')).toBe(true);
    await journal.recover('one', context);
    const effect = (await journal.pending())[0]!;
    expect(() =>
      journal.reconcileApplyNow(
        'one',
        { ...context, attemptId: 'other' },
        effect.fingerprint,
        '{}',
      ),
    ).toThrow();
    expect(() => journal.reconcileApplyNow('one', context, 'wrong', '{}')).toThrow();
    expect(() =>
      withImmediateTransaction(db, () => {
        journal.reconcileApplyNow('one', context, effect.fingerprint, '{}');
        throw Error('simulated transaction failure');
      }),
    ).toThrow('simulated transaction failure');
    expect(await journal.pending()).toHaveLength(1);
    journal.reconcileApplyNow('one', context, effect.fingerprint, '{}');
    expect(await journal.pending()).toEqual([]);
    expect(db.prepare('SELECT outcome FROM tool_invocations_v2').get()?.['outcome']).toBe(
      'uncertain',
    );
    expect(await journal.claim('one', 'coding_apply', context, 'exact')).toBe(false);
    expect(() => journal.reconcileApplyNow('one', context, effect.fingerprint, '{}')).toThrow();
    expect(
      await journal.claim('two', 'write_file', { taskRunId: 'run', attemptId: 'attempt' }, 'new'),
    ).toBe(true);
    await journal.recover('two', { taskRunId: 'run', attemptId: 'attempt' });
    const other = (await journal.pending())[0]!;
    expect(() => journal.reconcileApplyNow('two', other, other.fingerprint, '{}')).toThrow();
    expect(await journal.pending()).toHaveLength(1);
  } finally {
    db.close();
  }
});
