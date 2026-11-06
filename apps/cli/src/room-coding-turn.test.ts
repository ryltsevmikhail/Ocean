import { expect, it } from 'vitest';
import { createChatCommand } from '@runnets/application';
import { setup, settledRead, effects } from '../test-fixtures/room-coding.js';
it('selects dev-only marked schemas without qualifying or creating a worker before a model start', async () => {
  const f = setup();
  try {
    expect(f.claim.kind).toBe('claimed');
    if (f.claim.kind !== 'claimed') throw Error('claim');
    expect(f.claim.turn.codingTaskId).toBe(f.b.id);
    await f.runs.execute(createChatCommand(f.claim.turn, f.claim.parentRunId));
    const tools = await f.factory.forTurn(f.claim.turn, new AbortController().signal);
    expect(tools.definitions.map((d) => d.name)).toContain('read_file');
    expect(effects).toEqual({ qualifications: 0, sessions: 0, reads: 0 });
  } finally {
    f.close();
  }
});

it('claims one actual worktree observation before lazy session setup and replays the local result without a second read', async () => {
  const f = setup();
  try {
    const r = await settledRead(f),
      signal = new AbortController().signal;
    expect(await r.tools.execute(r.call, signal, r.context)).toMatchObject({
      isError: false,
      output: 'read',
    });
    expect(await r.tools.execute(r.call, signal, r.context)).toMatchObject({
      isError: false,
      output: 'read',
    });
    expect(effects).toEqual({ qualifications: 1, sessions: 1, reads: 1 });
    const rows = f.db
      .prepare('SELECT tool,outcome,admission FROM tool_invocations_v2 WHERE task_run_id=?')
      .all(r.context.taskRunId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'coding_read', outcome: 'completed' });
    expect(JSON.parse(String(rows[0]!['admission']))).toMatchObject({
      effectKind: 'observation',
      scope: { resources: [{ worktreeId: f.b.id }] },
      binding: {
        roomBasis: [{ chargedRunId: r.context.taskRunId, grantId: 'grant-task-b', revision: 2 }],
      },
    });
  } finally {
    f.close();
  }
});
it('holds a marked read before setup when the live worktree lease was lost', async () => {
  const f = setup();
  try {
    const r = await settledRead(f);
    f.live.delete('worktree-b');
    expect(await r.tools.execute(r.call, new AbortController().signal, r.context)).toMatchObject({
      isError: true,
    });
    expect(effects).toEqual({ qualifications: 0, sessions: 0, reads: 0 });
    expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  } finally {
    f.close();
  }
});
it('uses exact existing C claims for marked edit and registered preset with the frozen debit basis', async () => {
  const f = setup();
  try {
    const r = await settledRead(f),
      signal = r.controller.signal;
    expect(await r.tools.execute(r.call, signal, r.context)).toMatchObject({ isError: false });
    for (const [name, args] of [
      ['write_file', { path: 'file', content: 'after' }],
      ['run_test', { presetId: 'test' }],
    ] as const) {
      const result = await r.tools.execute(
        { id: r.context.attemptId + '_r1_' + name, name, arguments: JSON.stringify(args) },
        signal,
        r.context,
      );
      expect(result).toMatchObject({ isError: false });
    }
    const approvals = f.db
      .prepare('SELECT payload FROM ocean_coding_approvals')
      .all()
      .map((row) => JSON.parse(String(row['payload'])));
    expect(approvals).toHaveLength(2);
    expect(
      approvals.every(
        (a) => a.status === 'consumed' && a.roomBasis?.[0]?.chargedRunId === r.context.taskRunId,
      ),
    ).toBe(true);
    expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(3);
  } finally {
    f.close();
  }
});

it('preserves valid immutable coding assignment with communication-only selected authority', async () => {
  const f = setup('autonomous', false);
  try {
    expect(f.claim.kind).toBe('claimed');
    if (f.claim.kind !== 'claimed') throw Error('claim');
    expect(f.claim.turn.codingTaskId).toBe(f.b.id);
    await f.runs.execute(createChatCommand(f.claim.turn, f.claim.parentRunId));
    const tools = await f.factory.forTurn(f.claim.turn, new AbortController().signal);
    expect(tools.definitions).toEqual([]);
    expect(effects).toEqual({ qualifications: 0, sessions: 0, reads: 0 });
  } finally {
    f.close();
  }
});
it('prepares a preset-only selected action without project_read authority', async () => {
  const f = setup('autonomous', true, false, ['run_test_preset']);
  try {
    const r = await settledRead(f);
    expect(r.tools.definitions.map((d) => d.name)).toEqual(['run_test']);
    expect(
      await r.tools.execute(
        {
          id: r.context.attemptId + '_r1_preset',
          name: 'run_test',
          arguments: '{"presetId":"test"}',
        },
        r.controller.signal,
        r.context,
      ),
    ).toMatchObject({ isError: false });
    expect(effects.reads).toBe(0);
  } finally {
    f.close();
  }
});
