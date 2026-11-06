import { roomTaskOrigin, roomOriginRunMatches } from './room-task-origin.js';
import type { DatabaseSync } from 'node:sqlite';
import type { RoomTaskTransaction } from '@runnets/application';
import { canonicalJson, isCreated, replay, type TaskRunEvent } from '@runnets/domain';
import { eventRecordFromRow, fromEventRecord } from './event-record.js';
import { lookupSqliteCommand } from './command-commit.js';
import { decodeRoomDelivery, readRoomTask } from './room-task-storage.js';
/** Locked contiguous event replay; null never means absence. */
function eventsFor(db: DatabaseSync, id: string) {
  const events = db
    .prepare('SELECT * FROM events WHERE aggregate_id=? ORDER BY sequence')
    .all(id)
    .map((r) => fromEventRecord(eventRecordFromRow(r)) as TaskRunEvent);
  if (
    !events.every(
      (e, i) => e.aggregateId === id && e.aggregateType === 'task_run' && e.sequence === i + 1,
    )
  )
    throw Error('invalid room event stream');
  return events;
}
export function roomTaskSliceStorage(
  db: DatabaseSync,
): Pick<
  RoomTaskTransaction,
  | 'delivery'
  | 'inputs'
  | 'tasks'
  | 'claim'
  | 'consume'
  | 'advanceTask'
  | 'completeEvidence'
  | 'unstartedEvidence'
> {
  return {
    delivery(id) {
      const r = db.prepare('SELECT * FROM ocean_room_deliveries WHERE id=?').get(id);
      return r ? decodeRoomDelivery(r) : null;
    },
    inputs: (id) =>
      db
        .prepare(
          "SELECT * FROM ocean_room_deliveries WHERE to_task_id=? ORDER BY CASE WHEN kind='result' THEN 0 ELSE 1 END,seq,position,id",
        )
        .all(id)
        .map(decodeRoomDelivery),
    tasks: (id) =>
      db
        .prepare('SELECT id FROM ocean_room_tasks WHERE root_id=? ORDER BY id')
        .all(id)
        .map((r) => readRoomTask(db, String(r['id']))!),
    claim(id) {
      if (
        db
          .prepare("UPDATE ocean_room_deliveries SET state='claimed' WHERE id=? AND state='queued'")
          .run(id).changes !== 1
      )
        throw Error('delivery claim conflict');
    },
    consume(id) {
      if (
        db
          .prepare(
            "UPDATE ocean_room_deliveries SET state='consumed' WHERE id=? AND state='claimed'",
          )
          .run(id).changes !== 1
      )
        throw Error('delivery consumption conflict');
    },
    advanceTask(t, expected) {
      if (
        db
          .prepare(
            'UPDATE ocean_room_tasks SET status=?,waiting_child_id=?,last_delivery_seq=?,revision=revision+1 WHERE id=? AND revision=?',
          )
          .run(t.status, t.waitingChildId, t.lastDeliverySeq, t.id, expected).changes !== 1
      )
        throw Error('revision_conflict');
    },
    completeEvidence(command) {
      try {
        const events = eventsFor(db, command.taskRunId),
          run = replay(events),
          headEvent = events.at(-1);
        if (
          !isCreated(run) ||
          !headEvent ||
          run.id !== command.taskRunId ||
          run.version !== headEvent.sequence
        )
          return null;
        const turn = db
          .prepare('SELECT id FROM ocean_chat_turns WHERE task_run_id=?')
          .get(command.taskRunId);
        const facts =
          turn &&
          roomTaskOrigin(
            db,
            String(turn['id']),
            command.taskRunId,
            command.payload.attemptId,
            false,
          );
        if (
          !facts ||
          !roomOriginRunMatches(
            facts.turn,
            facts.root,
            run,
            command.payload.attemptId,
            facts.turn.roomHandoff
              ? 'tool_calls'
              : facts.turn.stopReason === 'max_tokens'
                ? 'length'
                : 'stop',
          )
        )
          return null;
        const receipt = lookupSqliteCommand(db, command);
        return receipt.ok ? { run, headEvent, receipt: receipt.value } : null;
      } catch {
        return null;
      }
    },
    unstartedEvidence(command) {
      const id = command.taskRunId;
      try {
        const receipt = lookupSqliteCommand(db, command);
        if (!receipt.ok) return null;
        if (
          db.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_invocations_v2'").get() &&
          db.prepare('SELECT 1 FROM tool_invocations_v2 WHERE task_run_id=? LIMIT 1').get(id)
        )
          return null;
        const events = eventsFor(db, id);
        if (events.length === 0) {
          if (receipt.value !== null) return null;
          if (
            db
              .prepare(
                'SELECT 1 FROM command_receipts WHERE aggregate_id=? UNION ALL SELECT 1 FROM checkpoints WHERE aggregate_id=? LIMIT 1',
              )
              .get(id, id)
          )
            return null;
          return { kind: 'absent' };
        }
        const run = replay(events),
          headEvent = events.at(-1)!;
        if (
          !isCreated(run) ||
          run.status !== 'created' ||
          run.version !== 1 ||
          events.length !== 1 ||
          run.attemptCount !== 0 ||
          run.activeAttempt !== null ||
          run.modelExecution !== null
        )
          return null;
        if (
          !receipt.value ||
          receipt.value.version !== 1 ||
          receipt.value.events.length !== 1 ||
          canonicalJson(receipt.value.events[0]) !== canonicalJson(headEvent) ||
          canonicalJson(headEvent.actor) !== canonicalJson(command.actor) ||
          headEvent.causationId !== command.commandId ||
          canonicalJson(run.budget.limits) !== canonicalJson(command.payload.budget) ||
          run.model !== command.payload.model ||
          run.parentTaskRunId !== command.payload.parentTaskRunId ||
          run.workspaceId !== command.payload.workspaceId ||
          run.conversationId !== command.payload.conversationId ||
          run.policyId !== command.payload.policyId
        )
          return null;
        if (
          db
            .prepare(
              `SELECT 1 FROM command_receipts WHERE aggregate_id=? AND command_id<>?
          UNION ALL SELECT 1 FROM checkpoints WHERE aggregate_id=? LIMIT 1`,
            )
            .get(id, command.commandId, id)
        )
          return null;
        return { kind: 'created', run, headEvent };
      } catch {
        return null;
      }
    },
  };
}
