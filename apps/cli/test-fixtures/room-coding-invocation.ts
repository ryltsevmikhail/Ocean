import { expect } from 'vitest';
import { createChatCommand, executeStep } from '@runnets/application';
import { taskRunId } from '@runnets/domain';
import type { setup } from './room-coding.js';
export async function settledRead(f: ReturnType<typeof setup>, prepare = true) {
  if (f.claim.kind !== 'claimed') throw Error('coded claim required');
  const turn = f.claim.turn,
    id = taskRunId(turn.taskRunId),
    attemptId = turn.taskRunId + '_at_0001';
  await f.runs.execute(createChatCommand(turn, f.claim.parentRunId));
  const controller = new AbortController();
  const tools = prepare ? await f.factory.forTurn(turn, controller.signal) : undefined;
  f.store.conversations.atomic((tx) => tx.putChatTurn({ ...turn, status: 'dispatching' }));
  await executeStep(f.runs, id, 'Admit', {}, 1);
  await executeStep(f.runs, id, 'Schedule', {}, 2);
  await executeStep(
    f.runs,
    id,
    'StartAttempt',
    { attemptId, reason: 'initial', provider: 'test', model: 'test' },
    3,
  );
  const started = await executeStep(
    f.runs,
    id,
    'StartModelRequest',
    {
      attemptId,
      ordinal: 1,
      activation: turn.activation!,
      startedAt: f.deps.clock.now().toISOString(),
    },
    4,
  );
  expect(started.ok).toBe(true);
  await executeStep(
    f.runs,
    id,
    'SettleModelRequest',
    {
      attemptId,
      ordinal: 1,
      finishedAt: f.deps.clock.now().toISOString(),
      completion: { kind: 'terminal', stopReason: 'tool_calls' },
      usage: { kind: 'actual', tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    },
    5,
  );
  return {
    tools: tools!,
    controller,
    context: { taskRunId: turn.taskRunId, attemptId },
    call: { id: attemptId + '_r1_read', name: 'read_file', arguments: '{"path":"README.md"}' },
  };
}
