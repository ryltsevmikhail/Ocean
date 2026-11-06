import { canonicalJson, taskRunId, type ChatTurn } from '@runnets/domain';
import type { ChatTurnExecutionDeps } from './chat-turn-execution.js';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import { inspectUnstartedRoomClaim } from './room-delivery-claim.js';
import { stepCommand } from './commands.js';
/** Call only after the host has joined this claim's executor, or before it starts preparation. */
export async function releaseUnstartedRoomClaim(
  deps: Pick<ChatTurnExecutionDeps, 'store' | 'tasks' | 'clock'> &
    Pick<RoomTaskPersistenceDeps, 'ownerId' | 'sha256'>,
  turnId: string,
): Promise<boolean> {
  const inspected = deps.store.atomic((tx) => {
    const turn = tx.chatTurn(turnId);
    if (!turn) return null;
    const proof = inspectUnstartedRoomClaim(
      tx,
      turn,
      {
        ...deps,
        nextId: () => {
          throw Error('no allocation');
        },
      },
      true,
    );
    if (!proof) return null;
    if (proof.evidence.kind === 'absent') {
      tx.putChatTurn({ ...turn, status: 'cancelled' });
      return { turn, absent: true };
    }
    return { turn, absent: false };
  });
  if (!inspected) return false;
  if (inspected.absent) return true;
  const id = taskRunId(inspected.turn.taskRunId);
  const request = stepCommand(id, 'RequestCancel', { cause: 'client cancelled' }, 1);
  const cancel = await deps.tasks.execute(request);
  if (!cancel.ok) return false;
  const safe = deps.store.atomic((tx) => {
    const current = tx.chatTurn(turnId),
      effects = tx.chatFailureEvidence?.(id);
    return (
      canonicalJson(current) === canonicalJson(inspected.turn) &&
      effects?.taskVersion === 2 &&
      effects.relatedPendingEffects === 0
    );
  });
  if (!safe) return false;
  const cleanup = await deps.tasks.execute(
    stepCommand(id, 'CompleteCleanup', { cleanup: 'completed' }, 2),
  );
  if (!cleanup.ok) return false;
  return recordCancelledRoomTurn(deps, inspected.turn);
}
/** A terminal Core cancellation proves cleanup; unknown stream/effect outcomes remain held. */
export async function recordCancelledRoomTurn(
  deps: Pick<ChatTurnExecutionDeps, 'store' | 'tasks'>,
  turn: ChatTurn,
): Promise<boolean> {
  const state = await deps.tasks.state(taskRunId(turn.taskRunId));
  if (state.status !== 'cancelled' || state.terminal?.status !== 'cancelled') return false;
  return deps.store.atomic((tx) => {
    const current = tx.chatTurn(turn.id),
      effects = tx.chatFailureEvidence?.(turn.taskRunId);
    if (
      !current ||
      canonicalJson(current) !== canonicalJson(turn) ||
      !['accepted', 'dispatching'].includes(current.status) ||
      current.roomHandoff ||
      effects?.taskVersion !== state.version ||
      effects.relatedPendingEffects !== 0
    )
      return false;
    tx.putChatTurn({ ...current, status: 'cancelled', text: '' });
    return true;
  });
}
