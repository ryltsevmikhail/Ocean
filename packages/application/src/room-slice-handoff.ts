/** Internal evidence for a committed local delegation; never model-provided authority. */
import { DomainError, validConversationText, type Command } from '@runnets/domain';
import { RUNTIME_ACTOR } from './commands.js';
import type { CommandReceipt } from './ports.js';
import type { ToolResult } from './tools.js';
import type { TurnInput, YieldedRoomSlice } from './types.js';

export interface RoomHandoff {
  readonly turnId: string;
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly callId: string;
  readonly childTaskId: string;
  readonly deliveryId: string;
  readonly expectedRunVersion: number;
}
const handoffs = new WeakMap<ToolResult, RoomHandoff>();
const SUMMARY = 'Room delegation committed';

/** Future trusted producer calls this only after durable admission. No host uses it yet. */
export function committedRoomDelegate(proof: RoomHandoff): ToolResult {
  const { turnId, taskRunId, attemptId, callId, childTaskId, deliveryId, expectedRunVersion } =
    proof;
  if (
    ![turnId, taskRunId, attemptId, childTaskId, deliveryId].every((id) =>
      validConversationText(id, 128),
    ) ||
    !validConversationText(callId, 512) ||
    !Number.isSafeInteger(expectedRunVersion) ||
    expectedRunVersion < 1 ||
    !Number.isSafeInteger(expectedRunVersion + 1)
  )
    throw DomainError.invalidArgument('invalid room handoff');
  const snapshot = Object.freeze({
    turnId,
    taskRunId,
    attemptId,
    callId,
    childTaskId,
    deliveryId,
    expectedRunVersion,
  });
  const result: ToolResult = Object.freeze({ isError: false, output: SUMMARY });
  handoffs.set(result, snapshot);
  return result;
}

export function roomHandoffOf(result: ToolResult): RoomHandoff | undefined {
  return handoffs.get(result);
}

/** One version-bound Complete, proven by its exact receipt and the actual committed head. */
export async function finishRoomHandoff(
  input: TurnInput,
  proof: RoomHandoff,
): Promise<YieldedRoomSlice> {
  if (proof.taskRunId !== input.taskRunId) throw Error('room handoff run mismatch');
  const command: Command<'Complete'> = {
    type: 'Complete',
    commandId: `room-handoff-complete/v1:${proof.turnId}`,
    taskRunId: input.taskRunId,
    actor: RUNTIME_ACTOR,
    expectedVersion: proof.expectedRunVersion,
    payload: { attemptId: proof.attemptId, summary: SUMMARY },
  };
  let receipt: CommandReceipt | null = null;
  let result;
  try {
    // TaskRunService → domain.decide reuses guardModelDispatch before committing.
    result = await input.service.executeWithDisposition(command);
  } catch {
    // Only an unchanged request lookup can recover a lost response; never resubmit.
    const lookup = await input.service.lookupCommand(command);
    if (!lookup.ok) throw lookup.error;
    receipt = lookup.value;
  }
  if (result !== undefined) {
    if (!result.ok) throw result.error;
    if (result.value.disposition !== 'committed' && result.value.disposition !== 'replayed')
      throw Error('unproven completion disposition');
    receipt = result.value.receipt;
  }
  const event = receipt?.events[0];
  if (
    receipt === null ||
    receipt.commandId !== command.commandId ||
    receipt.taskRunId !== input.taskRunId ||
    receipt.version !== proof.expectedRunVersion + 1 ||
    receipt.events.length !== 1 ||
    event?.type !== 'task_run.succeeded' ||
    event.sequence !== receipt.version ||
    event.aggregateType !== 'task_run' ||
    event.aggregateId !== input.taskRunId ||
    event.causationId !== command.commandId ||
    event.actor.kind !== RUNTIME_ACTOR.kind ||
    event.actor.id !== RUNTIME_ACTOR.id ||
    Object.keys(event.actor).length !== 2 ||
    Object.keys(event.payload).length !== 2 ||
    event.payload.attemptId !== proof.attemptId ||
    event.payload.summary !== SUMMARY
  )
    throw Error('room handoff completion receipt uncertain');
  const state = await input.service.state(input.taskRunId);
  if (
    state.status !== 'succeeded' ||
    state.id !== input.taskRunId ||
    state.version !== receipt.version ||
    state.terminal?.status !== 'succeeded' ||
    state.terminal.summary !== SUMMARY ||
    state.terminal.failure !== null ||
    state.activeAttempt?.attemptId !== proof.attemptId
  )
    throw Error('room handoff completion head uncertain');
  return { kind: 'yielded', handoff: proof };
}
