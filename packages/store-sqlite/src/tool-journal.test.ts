import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { SqliteToolJournal } from './tool-journal.js';

it('persists a claim before dispatch and refuses replay even when its outcome is unknown', async () => {
  const context = { taskRunId: 'tr_1', attemptId: 'at_1' };
  const db = new DatabaseSync(':memory:');
  try {
    const first = new SqliteToolJournal(db);
    expect(await first.claim('tr_1_round_1_call_1', 'write_file', context, 'fingerprint')).toBe(
      true,
    );
    const restarted = new SqliteToolJournal(db);
    expect(await restarted.claim('tr_1_round_1_call_1', 'write_file', context, 'fingerprint')).toBe(
      false,
    );
    await restarted.settle('tr_1_round_1_call_1', 'uncertain', context);
    expect(await restarted.claim('tr_1_round_1_call_1', 'run_command', context, 'different')).toBe(
      false,
    );
    await expect(restarted.settle('tr_1_round_1_call_1', 'completed', context)).rejects.toThrow();
  } finally {
    db.close();
  }
});

it('binds claims to run and attempt and recovers crashed claims without permitting replay', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new SqliteToolJournal(db);
    const context = { taskRunId: 'tr_1', attemptId: 'at_1' };
    expect(await journal.claim('call', 'edit', context, 'original')).toBe(true);
    expect(await journal.claim('call', 'edit', context, 'changed')).toBe(false);
    expect(await journal.pending()).toEqual([
      {
        ...context,
        id: 'call',
        tool: 'edit',
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: 'started',
      },
    ]);
    expect(JSON.stringify(await journal.pending())).not.toContain('original');
    await journal.recover('call', context);
    expect((await journal.pending('tr_1'))[0]?.outcome).toBe('uncertain');
    expect(await journal.claim('call', 'edit', context, 'original')).toBe(false);
    expect(await journal.claim('call', 'edit', { ...context, attemptId: 'at_2' }, 'new')).toBe(
      false,
    );
  } finally {
    db.close();
  }
});

it('surfaces legacy unscoped unresolved claims instead of silently losing them', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new SqliteToolJournal(db);
    db.prepare("INSERT INTO tool_invocations_v1 VALUES (?, ?, 'started')").run('old', 'edit');
    expect(await journal.pending()).toEqual([
      {
        id: 'old',
        tool: 'edit',
        taskRunId: '',
        attemptId: '',
        fingerprint: '',
        outcome: 'started',
      },
    ]);
    expect(await journal.claim('old', 'edit', { taskRunId: 'tr', attemptId: 'at' }, 'new')).toBe(
      false,
    );
  } finally {
    db.close();
  }
});
