import { describe, expect, it } from 'vitest';
import { InMemoryEventLog } from '@runnets/store';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  conversationId,
  decide,
  replay,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';

const command: AnyCommand = {
  type: 'CreateTaskRun',
  commandId: 'cm_direct',
  taskRunId: taskRunId('tr_direct'),
  expectedVersion: 0,
  actor: { kind: 'user', id: 'owner' },
  payload: {
    conversationId: conversationId('cv_direct'),
    workspaceId: workspaceId('ws_direct'),
    parentTaskRunId: null,
    model: 'model',
    policyId: 'pl_policy',
    budget: unlimitedBudget(),
  },
};
const meta = {
  correlationId: command.taskRunId,
  timestamp: '2026-01-01T00:00:00.000Z',
  actorId: 'owner',
};

describe.each(['memory', 'sqlite'])('direct %s atomic disposition', (adapter) => {
  it('commits exactly once when two callers pass the same precomputed decision', async () => {
    const sqlite = adapter === 'sqlite' ? openSqliteStore({ path: ':memory:' }) : null;
    const log = sqlite?.log ?? new InMemoryEventLog();
    try {
      const commands = log.commands;
      if (!commands?.commitWithDisposition) throw Error('missing atomic disposition port');
      const decision = decide(replay([]), command);
      if (!decision.ok) throw decision.error;
      const outcomes = await Promise.all([
        commands.commitWithDisposition(command, 0, decision.value, meta),
        commands.commitWithDisposition(command, 0, decision.value, meta),
      ]);
      const results = outcomes.map((outcome) => {
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      });
      expect(results.map((x) => x.disposition).sort()).toEqual(['committed', 'replayed']);
      expect(JSON.stringify(results[0]?.receipt)).toBe(JSON.stringify(results[1]?.receipt));
      expect(await commands.commit(command, 0, decision.value, meta)).toEqual({
        ok: true,
        value: results[0]?.receipt,
      });
      expect(await log.load(command.taskRunId)).toHaveLength(1);
      expect(
        await commands.commitWithDisposition(
          { ...command, expectedVersion: 1 },
          0,
          decision.value,
          meta,
        ),
      ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
      const stale = { ...command, commandId: 'cm_stale' };
      expect(await commands.commitWithDisposition(stale, 0, decision.value, meta)).toMatchObject({
        ok: false,
        error: { code: 'version_conflict' },
      });
      expect(await commands.lookup(stale)).toEqual({ ok: true, value: null });
      expect(await log.load(command.taskRunId)).toHaveLength(1);
    } finally {
      sqlite?.close();
    }
  });
});
