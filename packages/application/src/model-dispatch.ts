/** Durable request evidence is the sole authority for model dispatch. */
import {
  DomainError,
  type Command,
  type TaskRunEvent,
  type StartModelRequestPayload,
  type SettleModelRequestPayload,
} from '@runnets/domain';
import { RUNTIME_ACTOR } from './commands.js';
import { stateOf } from './lifecycle.js';
import { modelNow, normalizeModelActivation } from './model-activation.js';
import type { ModelRound } from './round.js';
import type { TurnInput } from './types.js';

/** A returned domain rejection proves this invocation did not obtain dispatch authority. */
export class ModelRequestRefused extends Error {
  constructor(error: DomainError) {
    super(error.message, { cause: error });
    this.name = 'ModelRequestRefused';
  }
}

export async function beginModelRequest(
  input: TurnInput,
  attemptId: string,
  ordinal: number,
): Promise<'dispatch' | 'replayed'> {
  // The state fold validates committed domain event payloads before use.
  const state = await stateOf(input);
  const events = (await input.service.events(input.taskRunId)) as readonly TaskRunEvent[];
  const prior = events.find(
    (e) =>
      e.type === 'attempt.model_request_started' &&
      e.payload.attemptId === attemptId &&
      e.payload.ordinal === ordinal,
  );
  const payload: StartModelRequestPayload =
    prior?.type === 'attempt.model_request_started'
      ? { ...prior.payload, activation: input.activation ?? prior.payload.activation }
      : {
          attemptId,
          ordinal,
          activation: input.activation ?? normalizeModelActivation(input),
          startedAt: modelNow(input).toISOString(),
        };
  const command: Command<'StartModelRequest'> = {
    type: 'StartModelRequest',
    commandId: `cm_${input.taskRunId}_model_${attemptId}_${ordinal}_start`,
    taskRunId: input.taskRunId,
    expectedVersion: prior === undefined ? state.version : prior.sequence - 1,
    actor: RUNTIME_ACTOR,
    payload,
  };
  if (prior === undefined && input.signal.aborted)
    throw new ModelRequestRefused(
      DomainError.invalidArgument('model request cancelled before start'),
    );
  const result = await input.service.executeWithDisposition(command);
  if (!result.ok) throw new ModelRequestRefused(result.error);
  input.emit({
    sessionUpdate: 'current_mode_update',
    currentModeId: (await stateOf(input)).status,
  });
  return result.value.disposition === 'committed' ? 'dispatch' : 'replayed';
}

export async function settleModelRequest(
  input: TurnInput,
  attemptId: string,
  ordinal: number,
  round: ModelRound,
): Promise<void> {
  // The state fold validates committed domain event payloads before use.
  const state = await stateOf(input);
  const events = (await input.service.events(input.taskRunId)) as readonly TaskRunEvent[];
  const prior = events.find(
    (e) =>
      e.type === 'attempt.model_request_settled' &&
      e.payload.attemptId === attemptId &&
      e.payload.ordinal === ordinal,
  );
  const payload: SettleModelRequestPayload = {
    attemptId,
    ordinal,
    finishedAt:
      prior?.type === 'attempt.model_request_settled'
        ? prior.payload.finishedAt
        : modelNow(input).toISOString(),
    completion: round.completion,
    usage: round.usageEvidence,
  };
  const command: Command<'SettleModelRequest'> = {
    type: 'SettleModelRequest',
    commandId: `cm_${input.taskRunId}_model_${attemptId}_${ordinal}_settle`,
    taskRunId: input.taskRunId,
    expectedVersion: prior === undefined ? state.version : prior.sequence - 1,
    actor: RUNTIME_ACTOR,
    payload,
  };
  const result = await input.service.executeWithDisposition(command);
  if (!result.ok) throw result.error;
  input.emit({
    sessionUpdate: 'current_mode_update',
    currentModeId: (await stateOf(input)).status,
  });
}
