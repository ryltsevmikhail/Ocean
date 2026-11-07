import type { DatabaseSync } from 'node:sqlite';
import type { RoomTaskRoot, RoomTaskOriginFacts } from '@runnets/application';
import {
  canonicalJson,
  isCreated,
  replay,
  type ChatTurn,
  type TaskRunState,
} from '@runnets/domain';
import { decodeChatTurn } from './chat-storage.js';
import { decodeRoomDelivery, readRoomTask } from './room-task-storage.js';
import { eventRecordFromRow, fromEventRecord } from './event-record.js';
/** All reads share the caller's immediate transaction; replay never starts another lock. */
export function roomTaskOrigin(
  db: DatabaseSync,
  turnId: string,
  runId: string,
  attemptId: string,
  live: boolean | 'settled' | 'historical',
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
  if (live === false) return { turn, input, task, root, liveRun: null };
  if (
    live === true &&
    (turn.status !== 'dispatching' ||
      turn.continuationReviewId !== undefined ||
      turn.broadcast !== undefined ||
      input.state !== 'claimed' ||
      task.status !== 'ready' ||
      root.status !== 'ready')
  )
    return null;
  const member = (id: string) =>
    !!db
      .prepare('SELECT 1 FROM ocean_members WHERE workspace_id=? AND room_id=? AND bot_id=?')
      .get(turn.workspaceId, turn.roomId, id);
  if (live !== 'historical' && !member(turn.bot.id)) return null;
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
    const run = replay(events);
    if (!isCreated(run)) return null;
    const stop =
      live === true ? 'tool_calls' : run.modelExecution?.lastRequest.settlement?.completion;
    const reason =
      typeof stop === 'string' ? stop : stop?.kind === 'terminal' ? stop.stopReason : null;
    if (
      (live === true && (run.status !== 'running' || run.terminal !== null)) ||
      (reason !== 'tool_calls' && reason !== 'stop' && reason !== 'length') ||
      !roomOriginRunMatches(turn, root, run, attemptId, reason)
    )
      return null;
    return { turn, input, task, root, liveRun: run };
  } catch {
    return null;
  }
}

/** Identity and settlement checks shared by live send and locked completion evidence. */
export function roomOriginRunMatches(
  turn: ChatTurn,
  root: RoomTaskRoot,
  run: TaskRunState,
  attemptId: string,
  stop: 'tool_calls' | 'stop' | 'length',
): boolean {
  const pin = root.rootPayload.members.find((m) => m.botId === turn.bot.id),
    execution = run.modelExecution;
  const last = execution?.lastRequest,
    settlement = last?.settlement;
  return (
    run.id === turn.taskRunId &&
    run.cancellationCause === null &&
    run.activeAttempt?.attemptId === attemptId &&
    run.conversationId === `cv_${turn.roomId}` &&
    run.workspaceId === `ws_${turn.workspaceId}` &&
    run.model === turn.bot.model &&
    run.activeAttempt.provider === turn.bot.provider &&
    run.activeAttempt.model === turn.bot.model &&
    !!turn.activation &&
    !!execution &&
    !!pin &&
    pin.identity.botProfileVersion === turn.bot.profileVersion &&
    pin.identity.providerId === turn.bot.provider &&
    pin.identity.modelId === turn.bot.model &&
    turn.modelBinding?.connectionId === pin.identity.connectionId &&
    turn.modelBinding.modelId === pin.identity.modelId &&
    canonicalJson(turn.activation) === canonicalJson(execution.activation) &&
    canonicalJson(turn.activation.identity) === canonicalJson(pin.identity) &&
    last?.attemptId === attemptId &&
    !!settlement &&
    settlement.attemptId === attemptId &&
    settlement.ordinal === last.ordinal &&
    settlement.completion.kind === 'terminal' &&
    settlement.completion.stopReason === stop &&
    (turn.activation.capabilities.usage !== 'reported' || settlement.usage.kind === 'actual')
  );
}
