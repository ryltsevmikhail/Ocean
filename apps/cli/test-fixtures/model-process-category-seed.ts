import assert from 'node:assert/strict';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type ModelActivationSnapshot,
  type CommandType,
  type CommandPayloads,
  type Bot,
} from '@runnets/domain';
import { executeStep } from '@runnets/application';
import type { Runtime } from '../dist/runtime.js';
/** Synthetic journals created solely through public application commands/store ports before launch. */
export async function categorySeed(runtime: Runtime, bot: Bot, roomId: string) {
  const instant = new Date().toISOString();
  const activation: ModelActivationSnapshot = {
    version: 1,
    identity: { source: 'host', providerId: 'fixture', modelId: 'fixture' },
    capabilities: {
      tools: false,
      streaming: true,
      inputModalities: ['text'],
      contextTokens: null,
      maxOutputTokens: null,
      usage: 'optional',
    },
    limits: { maxModelRequests: 3, requestTimeoutMs: 120000, turnTimeoutMs: 600000 },
    admittedAt: instant,
    deadlineAt: new Date(Date.parse(instant) + 600000).toISOString(),
  };
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const runs: Record<string, string> = {};
  for (const mode of ['mixed', 'unavailable', 'legacy', 'prefix']) {
    const id = taskRunId('tr_fixture_' + mode);
    async function step<T extends CommandType>(type: T, payload: CommandPayloads[T]) {
      const state = await runtime.service.state(id);
      const result = await executeStep(runtime.service, id, type, payload, state.version);
      assert.equal(result.ok, true, type);
    }
    await step('CreateTaskRun', {
      conversationId: conversationId('cv_fixture_' + mode),
      workspaceId: workspaceId('ws_ws_ocean'),
      parentTaskRunId: null,
      model: 'fixture',
      policyId: 'pl_fixture',
      budget: unlimitedBudget(),
    });
    await step('Admit', {});
    await step('Schedule', {});
    await step('StartAttempt', {
      attemptId: 'at_fixture',
      reason: 'initial',
      provider: 'fixture',
      model: 'fixture',
    });
    if (mode === 'legacy' || mode === 'prefix')
      await step('RecordUsage', {
        attemptId: 'at_fixture',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
    if (mode !== 'legacy') {
      for (let ordinal = 1; ordinal <= (mode === 'mixed' ? 2 : 1); ordinal++) {
        await step('StartModelRequest', {
          attemptId: 'at_fixture',
          ordinal,
          activation,
          startedAt: instant,
        });
        await step('SettleModelRequest', {
          attemptId: 'at_fixture',
          ordinal,
          finishedAt: instant,
          completion: { kind: 'terminal', stopReason: 'stop' },
          usage:
            mode === 'unavailable'
              ? { kind: 'unavailable', reason: 'not_reported' }
              : mode === 'mixed' && ordinal === 1
                ? { kind: 'estimated', tokens: zero, estimator: 'fixture' }
                : { kind: 'actual', tokens: zero },
        });
      }
    }
    await step('Complete', { attemptId: 'at_fixture', summary: 'synthetic journal' });
    runtime.conversationStore!.atomic((tx) =>
      tx.putChatTurn({
        id: 'turn_' + mode,
        workspaceId: 'ws_ocean',
        roomId,
        requestId: 'seed_' + mode,
        taskRunId: id,
        inboundMessageId: 'message_' + mode,
        readThroughSeq: 1,
        bot,
        status: 'completed',
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
      }),
    );
    runs[mode] = id;
  }
  return runs;
}
