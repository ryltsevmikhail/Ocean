import {
  ABSENT,
  conversationId,
  decide,
  evolve,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
  type CommandPayloads,
  type CommandType,
  type ModelActivationSnapshot,
  type TaskRunAggregate,
  type TaskRunEvent,
  type TaskRunEventDraft,
  type TaskRunState,
} from '@runnets/domain';
export const activation = (): ModelActivationSnapshot => ({
  version: 1,
  identity: { source: 'host', providerId: 'test', modelId: 'test' },
  capabilities: {
    tools: true,
    streaming: true,
    inputModalities: ['text'],
    contextTokens: null,
    maxOutputTokens: null,
    usage: 'reported',
  },
  limits: { maxModelRequests: 3, requestTimeoutMs: 120000, turnTimeoutMs: 600000 },
  admittedAt: '2026-01-01T00:00:00Z',
  deadlineAt: '2026-01-01T00:10:00Z',
});
export function cmd<T extends CommandType>(
  state: TaskRunAggregate,
  type: T,
  payload: CommandPayloads[T],
): AnyCommand {
  return {
    type,
    payload,
    taskRunId: taskRunId('tr_model01'),
    expectedVersion: state.version,
    commandId: `cm_${type}_${state.version}`,
    actor: { kind: 'runtime', id: 'runtime' },
  } as AnyCommand;
}
export function eventOf(draft: TaskRunEventDraft, sequence: number): TaskRunEvent {
  return {
    ...draft,
    sequence,
    aggregateId: 'tr_model01',
    aggregateType: 'task_run',
    eventId: `ev_${sequence}`,
    timestamp: '2026-01-01T00:00:00Z',
    correlationId: 'test',
  } as TaskRunEvent;
}
export function apply<T extends CommandType>(
  state: TaskRunAggregate,
  type: T,
  payload: CommandPayloads[T],
) {
  const result = decide(state, cmd(state, type, payload));
  if (!result.ok) throw result.error;
  const events = result.value.map((draft, i) => eventOf(draft, state.version + i + 1));
  return { state: events.reduce(evolve, state) as TaskRunState, events };
}
export function running(limit: number | null = null) {
  let state: TaskRunAggregate = ABSENT;
  const history: TaskRunEvent[] = [];
  const steps: [CommandType, CommandPayloads[CommandType]][] = [
    [
      'CreateTaskRun',
      {
        conversationId: conversationId('cv_test'),
        workspaceId: workspaceId('ws_test'),
        parentTaskRunId: null,
        model: 'test',
        policyId: 'pl_test',
        budget: { ...unlimitedBudget(), provider_tokens: limit },
      },
    ],
    ['Admit', {}],
    ['Schedule', {}],
    ['StartAttempt', { attemptId: 'at_test', reason: 'initial', provider: 'test', model: 'test' }],
  ];
  for (const [type, payload] of steps) {
    const next: { state: TaskRunState; events: TaskRunEvent[] } = apply(state, type, payload);
    state = next.state;
    history.push(...next.events);
  }
  return { state: state as TaskRunState, history };
}
export const startPayload = (ordinal = 1) => ({
  attemptId: 'at_test',
  ordinal,
  activation: activation(),
  startedAt: '2026-01-01T00:00:01Z',
});
export const settlement = () => ({
  attemptId: 'at_test',
  ordinal: 1,
  finishedAt: '2026-01-01T00:00:02Z',
  completion: { kind: 'terminal' as const, stopReason: 'stop' as const },
  usage: { kind: 'actual' as const, tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
});
export const pending = (limit: number | null = null) =>
  apply(running(limit).state, 'StartModelRequest', startPayload()).state;
