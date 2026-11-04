import {
  ABSENT,
  evolve,
  taskRunId,
  type EventEnvelope,
  type ModelCompletionEvidence,
  type ModelExecutionIdentity,
  type ModelExecutionState,
  type ModelUsageEvidence,
  type TaskRunAggregate,
  type TaskRunEvent,
} from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { TaskRunService } from './service.js';
import type { RunQuery } from './chat-receipts.js';
import { boundedModelText } from './model-connection-input.js';
import { MODEL_READ_PAGE_BYTES } from './model-read-pages.js';
export type ModelExecutionReadIdentity =
  | { readonly source: 'host'; readonly providerId: string; readonly modelId: string }
  | {
      readonly source: 'connection';
      readonly connectionId: string;
      readonly modelId: string;
      readonly providerId: string;
      readonly connectionRevision: number;
      readonly botProfileVersion: number;
      readonly kind: 'cloud' | 'local';
    };
export interface ModelRequestCounts {
  readonly actual: number;
  readonly estimated: number;
  readonly unavailable: number;
  readonly pending: number;
}
export interface ModelExecutionProjection {
  readonly identity: ModelExecutionReadIdentity;
  readonly startedRequests: number;
  readonly lastRequest: {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly startedAt: string;
    readonly settlement: {
      readonly finishedAt: string;
      readonly completion: ModelCompletionEvidence;
      readonly usage: ModelUsageEvidence;
    } | null;
  };
  readonly usage: {
    readonly scope: 'recorded_model_requests';
    readonly knownTokensScope: 'run_ledger_including_legacy_prefix';
    readonly knownTokens: number;
    readonly estimatedTokens: number;
    readonly unavailableRequests: number;
    readonly requestCounts: ModelRequestCounts | null;
    /** Usage evidence for requests recorded so far, independent of completion/lifecycle/billing. */
    readonly completeness: 'complete' | 'incomplete' | 'unknown';
  };
}
export interface ModelExecutionSnapshot extends RunQuery {
  readonly version: 1;
  readonly runVersion: number;
  readonly execution: ModelExecutionProjection | null;
}
export interface ModelExecutionReadDeps {
  readonly store: ConversationStore;
  readonly tasks: Pick<TaskRunService, 'events'>;
}
function identity(i: ModelExecutionIdentity): ModelExecutionReadIdentity {
  const common = {
    providerId: boundedModelText(i.providerId, 64),
    modelId: boundedModelText(i.modelId, 256),
  };
  return i.source === 'host'
    ? { source: 'host', ...common }
    : {
        source: 'connection',
        ...common,
        connectionId: boundedModelText(i.connectionId, 256),
        connectionRevision: i.connectionRevision,
        botProfileVersion: i.botProfileVersion,
        kind: i.kind,
      };
}
function usage(u: ModelUsageEvidence): ModelUsageEvidence {
  if (u.kind === 'unavailable') return { kind: u.kind, reason: u.reason };
  const tokens = {
    inputTokens: u.tokens.inputTokens,
    outputTokens: u.tokens.outputTokens,
    totalTokens: u.tokens.totalTokens,
  };
  return u.kind === 'actual'
    ? { kind: u.kind, tokens }
    : { kind: u.kind, tokens, estimator: boundedModelText(u.estimator, 256) };
}
function project(
  execution: ModelExecutionState,
  counts: ModelRequestCounts | null,
): ModelExecutionProjection {
  const last = execution.lastRequest;
  const settled = last.settlement;
  const completion = settled?.completion;
  return {
    identity: identity(execution.activation.identity),
    startedRequests: execution.startedRequests,
    lastRequest: {
      attemptId: boundedModelText(last.attemptId, 128),
      ordinal: last.ordinal,
      startedAt: last.startedAt,
      settlement:
        settled === null || completion === undefined
          ? null
          : {
              finishedAt: settled.finishedAt,
              completion:
                completion.kind === 'terminal'
                  ? { kind: completion.kind, stopReason: completion.stopReason }
                  : { kind: completion.kind },
              usage: usage(settled.usage),
            },
    },
    usage: {
      scope: 'recorded_model_requests',
      knownTokensScope: 'run_ledger_including_legacy_prefix',
      knownTokens: execution.usage.knownTokens,
      estimatedTokens: execution.usage.estimatedTokens,
      unavailableRequests: execution.usage.unavailableRequests,
      requestCounts: counts,
      completeness:
        counts === null
          ? 'unknown'
          : counts.estimated + counts.unavailable + counts.pending > 0
            ? 'incomplete'
            : 'complete',
    },
  };
}
/** One committed materialization supplies both domain replay and category evidence. No second journal. */
function materialize(stream: readonly EventEnvelope[], query: RunQuery): ModelExecutionSnapshot {
  let state: TaskRunAggregate = ABSENT;
  let completeEvidence = true;
  let frozenIdentity: string | null = null;
  const requests = new Map<
    number,
    { attemptId: string; category: 'actual' | 'estimated' | 'unavailable' | 'pending' }
  >();
  for (let n = 0; n < stream.length; n++) {
    const event = stream[n]!;
    if (
      typeof event.type !== 'string' ||
      event.sequence !== n + 1 ||
      event.aggregateId !== query.runId ||
      event.aggregateType !== 'task_run'
    )
      throw Error();
    // evolve invokes the existing strict model start/settlement validators.
    state = evolve(state, event as TaskRunEvent);
    if (state.status === 'absent' || state.workspaceId !== query.workspaceId) throw Error();
    const execution = state.modelExecution;
    if (execution === null) continue;
    if (event.type === 'attempt.model_request_started') {
      const admitted = JSON.stringify(execution.activation.identity);
      if (frozenIdentity !== null && frozenIdentity !== admitted) throw Error();
      frozenIdentity = admitted;
      const last = execution.lastRequest;
      if (requests.has(last.ordinal) || last.ordinal !== requests.size + 1)
        completeEvidence = false;
      else requests.set(last.ordinal, { attemptId: last.attemptId, category: 'pending' });
    }
    if (event.type === 'attempt.model_request_settled') {
      const settled = execution.lastRequest.settlement;
      if (settled === null) throw Error();
      const request = requests.get(settled.ordinal);
      if (
        request === undefined ||
        request.attemptId !== settled.attemptId ||
        request.category !== 'pending' ||
        execution.lastRequest.ordinal !== settled.ordinal ||
        execution.lastRequest.attemptId !== settled.attemptId
      )
        completeEvidence = false;
      else request.category = settled.usage.kind;
    }
  }
  const execution = state.status === 'absent' ? null : state.modelExecution;
  const counts = { actual: 0, estimated: 0, unavailable: 0, pending: 0 };
  for (const request of requests.values()) counts[request.category]++;
  const known =
    execution !== null && completeEvidence && requests.size === execution.startedRequests;
  return {
    version: 1,
    ...query,
    runVersion: state.version,
    execution: execution === null ? null : project(execution, known ? counts : null),
  };
}
export class RoomModelExecutionReads {
  readonly deps: ModelExecutionReadDeps;
  constructor(deps: ModelExecutionReadDeps) {
    this.deps = deps;
  }
  async get(input: RunQuery): Promise<ModelExecutionSnapshot> {
    const query = {
      workspaceId: boundedModelText(input.workspaceId, 128),
      roomId: boundedModelText(input.roomId, 128),
      runId: boundedModelText(input.runId, 128),
    };
    const allowed = this.deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== query.workspaceId) return false;
      const room = tx.room(query.roomId);
      if (room === null || room.workspaceId !== query.workspaceId) return false;
      const turn = tx.roomChatRun(query.workspaceId, query.roomId, query.runId);
      return (
        turn !== null &&
        turn.workspaceId === query.workspaceId &&
        turn.roomId === query.roomId &&
        turn.taskRunId === query.runId
      );
    });
    if (!allowed) throw Error('unknown_run');
    const stream = await this.deps.tasks.events(taskRunId(query.runId));
    try {
      const result = materialize(stream, query);
      if (new TextEncoder().encode(JSON.stringify(result)).length > MODEL_READ_PAGE_BYTES)
        throw Error();
      return result;
    } catch {
      throw Error('model_execution_unavailable');
    }
  }
}
