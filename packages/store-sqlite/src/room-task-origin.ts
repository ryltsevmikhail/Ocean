import type { DatabaseSync } from 'node:sqlite';
import type { RoomTaskOriginFacts } from '@runnets/application';
import { canonicalJson, isCreated, replay } from '@runnets/domain';
import { decodeChatTurn } from './chat-storage.js';
import { decodeRoomDelivery, readRoomTask } from './room-task-storage.js';
import { eventRecordFromRow, fromEventRecord } from './event-record.js';
/** All reads share the caller's immediate transaction; replay never starts another lock. */
export function roomTaskOrigin(
  db: DatabaseSync,
  turnId: string,
  runId: string,
  attemptId: string,
  live: boolean,
): RoomTaskOriginFacts | null {
  const row = db
    .prepare('SELECT * FROM ocean_chat_turns WHERE id=? AND task_run_id=?')
    .get(turnId, runId);
  if (!row) return null;
  const turn = decodeChatTurn(row),
    marker = turn.roomDelivery;
  if (
    !marker ||
    marker.version !== 1 ||
    turn.id !== turnId ||
    turn.taskRunId !== runId ||
    turn.workspaceId !== row['workspace_id'] ||
    turn.roomId !== row['room_id'] ||
    turn.bot.workspaceId !== turn.workspaceId
  )
    return null;
  const raw = db.prepare('SELECT * FROM ocean_room_deliveries WHERE id=?').get(marker.deliveryId);
  if (!raw) return null;
  const input = decodeRoomDelivery(raw),
    task = readRoomTask(db, marker.taskId),
    root = readRoomTask(db, input.rootId);
  if (
    !task ||
    task.kind !== 'bot' ||
    !root ||
    root.kind !== 'root' ||
    input.toTaskId !== task.id ||
    task.rootId !== root.id ||
    input.recipientBotId !== task.assigneeBotId ||
    turn.bot.id !== task.assigneeBotId ||
    ![input, task, root].every(
      (v) => v.workspaceId === turn.workspaceId && v.roomId === turn.roomId,
    ) ||
    turn.inboundMessageId !== input.messageId ||
    turn.readThroughSeq !== input.seq
  )
    return null;
  if (!live) return { turn, input, task, root, liveRun: null };
  if (
    turn.status !== 'dispatching' ||
    turn.continuationReviewId !== undefined ||
    turn.broadcast !== undefined ||
    input.state !== 'claimed' ||
    task.status !== 'ready' ||
    root.status !== 'ready'
  )
    return null;
  const member = (id: string) =>
    !!db
      .prepare('SELECT 1 FROM ocean_members WHERE workspace_id=? AND room_id=? AND bot_id=?')
      .get(turn.workspaceId, turn.roomId, id);
  if (!member(turn.bot.id)) return null;
  try {
    const events = db
      .prepare('SELECT * FROM events WHERE aggregate_id=? ORDER BY sequence')
      .all(runId)
      .map((r) => fromEventRecord(eventRecordFromRow(r)));
    if (
      !events.length ||
      !events.every(
        (e, i) => e.aggregateId === runId && e.aggregateType === 'task_run' && e.sequence === i + 1,
      )
    )
      return null;
    const run = replay(events),
      pin = root.rootPayload.members.find((m) => m.botId === turn.bot.id);
    if (
      !isCreated(run) ||
      run.id !== runId ||
      run.status !== 'running' ||
      run.terminal !== null ||
      run.cancellationCause !== null ||
      run.activeAttempt?.attemptId !== attemptId ||
      run.conversationId !== `cv_${turn.roomId}` ||
      run.workspaceId !== `ws_${turn.workspaceId}` ||
      run.model !== turn.bot.model ||
      run.activeAttempt.provider !== turn.bot.provider ||
      run.activeAttempt.model !== turn.bot.model ||
      !turn.activation ||
      !run.modelExecution ||
      !pin ||
      pin.identity.botProfileVersion !== turn.bot.profileVersion ||
      pin.identity.providerId !== turn.bot.provider ||
      pin.identity.modelId !== turn.bot.model ||
      turn.modelBinding?.connectionId !== pin.identity.connectionId ||
      turn.modelBinding.modelId !== pin.identity.modelId ||
      canonicalJson(turn.activation) !== canonicalJson(run.modelExecution.activation) ||
      canonicalJson(turn.activation.identity) !== canonicalJson(pin.identity)
    )
      return null;
    const last = run.modelExecution.lastRequest;
    if (
      last.attemptId !== attemptId ||
      !last.settlement ||
      last.settlement.attemptId !== attemptId ||
      last.settlement.ordinal !== last.ordinal ||
      last.settlement.completion.kind !== 'terminal' ||
      last.settlement.completion.stopReason !== 'tool_calls'
    )
      return null;
    return { turn, input, task, root, liveRun: run };
  } catch {
    return null;
  }
}
