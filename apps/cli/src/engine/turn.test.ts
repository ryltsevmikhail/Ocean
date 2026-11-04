/** Deterministic turn tests use scripted providers and an in-memory service. */
import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@runnets/contracts';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type BudgetLimits,
  type CommandPayloads,
  type TaskRunId,
} from '@runnets/domain';
import type {
  ChatMessage,
  ModelRequest,
  ProviderEvent,
  ProviderPort,
} from '@runnets/provider-core';
import { ProviderError } from '@runnets/provider-core';
import type { TaskRunService } from '@runnets/application';

import { executeStep } from './commands.js';
import { runTurn } from './turn.js';
import { createService } from '../lifecycle.js';
const MODEL = 'fake-model';
const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: 'hi' }];

function providerOf(
  events: readonly ProviderEvent[],
  captured?: { request: ModelRequest | null },
): ProviderPort {
  return {
    id: 'fake',
    models: [MODEL],
    capabilities: { streaming: true, reasoning: true, usage: true },
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      if (captured !== undefined) captured.request = request;
      for (const event of events) yield event;
    },
  };
}

async function step<TType extends Parameters<typeof executeStep>[2]>(
  service: TaskRunService,
  id: TaskRunId,
  type: TType,
  payload: CommandPayloads[TType],
  version: number,
): Promise<void> {
  const result = await executeStep(service, id, type, payload, version);
  if (!result.ok) throw new Error(`${type} failed: ${result.error.code}`);
}

async function created(
  service: TaskRunService,
  id: TaskRunId,
  budget: BudgetLimits = unlimitedBudget(),
): Promise<void> {
  await step(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_engine01'),
      workspaceId: workspaceId('ws_engine01'),
      parentTaskRunId: null,
      model: MODEL,
      policyId: 'pl_engine01',
      budget,
    },
    0,
  );
}

function limited(providerTokens: number): BudgetLimits {
  return { ...unlimitedBudget(), provider_tokens: providerTokens };
}

async function state(service: TaskRunService, id: TaskRunId) {
  const aggregate = await service.state(id);
  if (aggregate.status === 'absent') throw new Error('expected a created run');
  return aggregate;
}

describe('runTurn', () => {
  it('completes a turn, streams reasoning and text, and records usage', async () => {
    const service = createService();
    const id = taskRunId('tr_engine01');
    await created(service, id);
    const updates: SessionUpdate[] = [];
    const captured: { request: ModelRequest | null } = { request: null };

    const outcome = await runTurn({
      service,
      provider: providerOf(
        [
          { type: 'reasoning_delta', text: 'plan' },
          { type: 'text_delta', text: 'Hello' },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
        ],
        captured,
      ),
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: new AbortController().signal,
      emit: (update) => updates.push(update),
    });

    expect(outcome).toEqual({ kind: 'completed', stopReason: 'end_turn', text: 'Hello' });
    const final = await state(service, id);
    expect(final.status).toBe('succeeded');
    expect(final.budget.consumed.provider_tokens).toBe(15);
    expect(final.terminal?.summary).toBe('Hello');
    expect(updates.some((update) => update.sessionUpdate === 'agent_thought_chunk')).toBe(true);
    expect(updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    expect(captured.request?.model).toBe(MODEL);
    expect(captured.request?.messages).toEqual(MESSAGES);
  });

  it('commits budget exhaustion when usage crosses a finite limit', async () => {
    const service = createService();
    const id = taskRunId('tr_engine02');
    await created(service, id, limited(10));

    const outcome = await runTurn({
      service,
      provider: providerOf([
        { type: 'text_delta', text: 'Hello' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: new AbortController().signal,
      emit: () => {},
    });

    expect(outcome.kind).toBe('failed');
    const final = await state(service, id);
    expect(final.status).toBe('budget_exhausted');
    expect(final.budget.consumed.provider_tokens).toBe(15);
    const events = await service.events(id);
    expect(events.map((event) => event.type)).toContain('attempt.usage_recorded');
    expect(events.map((event) => event.type)).toContain('task_run.budget_exhausted');
  });

  it('settles usage but holds unknown provider completion', async () => {
    const service = createService();
    const id = taskRunId('tr_engine03');
    await created(service, id);

    const outcome = await runTurn({
      service,
      provider: providerOf([
        { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
        {
          type: 'error',
          error: new ProviderError('server', 'upstream failure'),
        },
      ]),
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: new AbortController().signal,
      emit: () => {},
    });

    expect(outcome.kind).toBe('uncertain');
    const final = await state(service, id);
    expect(final.status).toBe('reconciling');
    expect(final.budget.consumed.provider_tokens).toBe(6);
    expect(final.terminal).toBeNull();
    expect(final.modelExecution?.lastRequest.settlement?.completion).toEqual({ kind: 'unknown' });
  });

  it('fails a turn when the provider reports no usage', async () => {
    const service = createService();
    const id = taskRunId('tr_engine04');
    await created(service, id);

    const outcome = await runTurn({
      service,
      provider: providerOf([
        { type: 'text_delta', text: 'Hello' },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: new AbortController().signal,
      emit: () => {},
    });

    expect(outcome.kind).toBe('failed');
    const final = await state(service, id);
    expect(final.status).toBe('failed');
    expect(final.terminal?.failure?.message).toContain('without reporting token usage');
  });

  it('preserves cancellation uncertainty when the provider stream is lost', async () => {
    const service = createService();
    const id = taskRunId('tr_engine05');
    await created(service, id);
    const controller = new AbortController();

    const provider: ProviderPort = {
      id: 'fake',
      models: [MODEL],
      capabilities: { streaming: true, reasoning: true, usage: true },
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: 'text_delta', text: 'partial' };
        controller.abort();
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    };

    const outcome = await runTurn({
      service,
      provider,
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: controller.signal,
      emit: () => {},
    });

    expect(outcome.kind).toBe('uncertain');
    expect(outcome.stopReason).toBe('refusal');
    expect(outcome.text).toContain('billing may be unknown');
    expect((await state(service, id)).status).toBe('cancelling');
    expect((await service.events(id)).map((event) => event.type)).not.toContain(
      'task_run.cancelled',
    );
  });

  it('exhausts the budget before dispatch when no tokens remain after a retry', async () => {
    const service = createService();
    const id = taskRunId('tr_engine06');
    await created(service, id, limited(10));
    await step(service, id, 'Admit', {}, 1);
    await step(service, id, 'Schedule', {}, 2);
    await step(
      service,
      id,
      'StartAttempt',
      { attemptId: 'at_0001', reason: 'initial', provider: 'fake', model: MODEL },
      3,
    );
    await step(
      service,
      id,
      'RecordUsage',
      { attemptId: 'at_0001', usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } },
      4,
    );
    await step(
      service,
      id,
      'Retry',
      { delayMs: 1000, dueAt: '2026-01-01T00:00:05Z', attemptId: 'at_0001' },
      5,
    );

    const outcome = await runTurn({
      service,
      provider: providerOf([
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
      taskRunId: id,
      model: MODEL,
      messages: MESSAGES,
      signal: new AbortController().signal,
      emit: () => {},
    });

    expect(outcome.kind).toBe('failed');
    const final = await state(service, id);
    expect(final.status).toBe('budget_exhausted');
    expect(final.budget.consumed.provider_tokens).toBe(10);
  });
});
