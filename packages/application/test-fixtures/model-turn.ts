import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type BudgetLimits,
  type ModelActivationSnapshot,
} from '@runnets/domain';
import { InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import {
  TaskRunService,
  executeStep,
  type ProviderEvent,
  type ProviderPort,
  type EventLogPort,
  type TurnInput,
} from '@runnets/application';

export const instant = '2026-11-04T00:00:00.000Z';
export function activation(
  usage: 'reported' | 'optional' | 'unavailable' = 'reported',
): ModelActivationSnapshot {
  return {
    version: 1,
    identity: { source: 'host', providerId: 'scripted', modelId: 'scripted' },
    capabilities: {
      tools: true,
      streaming: true,
      inputModalities: ['text'],
      contextTokens: null,
      maxOutputTokens: null,
      usage,
    },
    limits: { maxModelRequests: 24, requestTimeoutMs: 120000, turnTimeoutMs: 600000 },
    admittedAt: instant,
    deadlineAt: '2026-11-04T00:10:00.000Z',
  };
}
export function provider(events: readonly ProviderEvent[]): ProviderPort {
  return {
    id: 'scripted',
    models: ['scripted'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream() {
      yield* events;
    },
  };
}
export const terminal = { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' } as const;
export const usage = {
  type: 'usage',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
} as const;
export async function setup(
  events: readonly ProviderEvent[] = [usage, terminal],
  budget: BudgetLimits = unlimitedBudget(),
  log: EventLogPort = new InMemoryEventLog(),
): Promise<TurnInput> {
  const clock = { now: () => new Date(instant) };
  const service = new TaskRunService({ log, ids: new SequentialIdGenerator(), clock });
  const id = taskRunId('tr_model_turn');
  const created = await executeStep(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_model_turn'),
      workspaceId: workspaceId('ws_model_turn'),
      parentTaskRunId: null,
      model: 'scripted',
      policyId: 'pl_model_turn',
      budget,
    },
    0,
  );
  if (!created.ok) throw created.error;
  return {
    service,
    taskRunId: id,
    clock,
    provider: provider(events),
    model: 'scripted',
    messages: [],
    signal: new AbortController().signal,
    emit: () => {},
  };
}
