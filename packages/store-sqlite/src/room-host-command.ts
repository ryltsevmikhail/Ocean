import { roomAuthorityEvidence } from './room-authority-evidence.js';
import { inspectPendingEffects } from './tool-journal-reads.js';
import { admitRoomCount } from '@runnets/application';
import type { ToolEffectAdmission } from '@runnets/domain';
import { createHash } from 'node:crypto';
import { canonicalJson, isCreated, replay, type AnyCommand } from '@runnets/domain';
import {
  roomSliceAuthority,
  roomCodingTask,
  roomTaskSubjects,
  type RoomAuthorityRead,
  type RoomPhysicalScope,
} from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import type { RoomHostBinding } from './room-host-storage.js';
import { roomHostCounts, freezeRoomHost } from './room-host-storage.js';
import { roomTaskStorage } from './room-task-storage.js';
import { botRow, roomRow, workspaceRow } from './conversation-rows.js';
import { modelBindingStorage } from './model-binding-storage.js';
import { roomModelPolicyStorage } from './room-model-policy-storage.js';
import { reviewStorage } from './review-storage.js';
import { chatStorage } from './chat-storage.js';
import { broadcastStorage } from './broadcast-storage.js';
import { eventRecordFromRow, fromEventRecord } from './event-record.js';
export function roomAuthorityReads(db: DatabaseSync, host: RoomHostBinding): RoomAuthorityRead {
  return {
    ...roomAuthorityEvidence(db),
    roomTasks: roomTaskStorage(db, host),
    bot(id) {
      const row = db.prepare('SELECT * FROM ocean_bots WHERE id=?').get(id);
      return row ? botRow(row) : null;
    },
    workspace() {
      const row = db.prepare('SELECT * FROM ocean_workspace WHERE singleton=1').get();
      return row ? workspaceRow(row) : null;
    },
    room(id) {
      const row = db.prepare('SELECT * FROM ocean_rooms WHERE id=?').get(id);
      return row
        ? roomRow(
            row,
            db
              .prepare('SELECT bot_id FROM ocean_members WHERE room_id=? ORDER BY bot_id')
              .all(id)
              .map((r) => String(r['bot_id'])),
          )
        : null;
    },
    modelBinding: (id) => modelBindingStorage(db).modelBinding(id),
    roomPolicy: reviewStorage(db).roomPolicy,
    roomModelPolicy: roomModelPolicyStorage(db).roomModelPolicy,
    activeChatTurn: (id) => chatStorage(db).activeChatTurn(id),
    broadcastBatchForRoom: (id) => broadcastStorage(db).batchForRoom(id),
  };
}
/** Current start authority is re-read under the caller's actual write lock. */
export function roomHostModelAllowed(
  db: DatabaseSync,
  host: RoomHostBinding,
  runId: string,
  now: number,
  command?: Extract<AnyCommand, { type: 'StartModelRequest' }>,
): boolean {
  if (!db.isTransaction) return false;
  const tx = roomAuthorityReads(db, host);
  const row = db.prepare('SELECT id FROM ocean_chat_turns WHERE task_run_id=?').get(runId);
  if (!row) return command !== undefined;
  const current = chatStorage(db).chatTurn(String(row['id']));
  if (!current?.roomDelivery) return command !== undefined;
  const rt = tx.roomTasks!,
    task = rt.task(current.roomDelivery.taskId),
    input = rt.delivery(current.roomDelivery.deliveryId);
  const root = task && rt.task(task.rootId);
  if (
    !task ||
    task.kind !== 'bot' ||
    !root ||
    root.kind !== 'root' ||
    !input ||
    input.state !== 'claimed' ||
    input.toTaskId !== task.id ||
    input.rootId !== root.id ||
    current.status !== 'dispatching' ||
    current.inboundMessageId !== input.messageId ||
    current.readThroughSeq !== input.seq ||
    current.workspaceId !== root.workspaceId ||
    current.roomId !== root.roomId ||
    current.bot.id !== task.assigneeBotId ||
    !current.activation ||
    now >= Date.parse(current.activation.deadlineAt) ||
    !roomSliceAuthority(tx, root, task, now, (s) => createHash('sha256').update(s).digest('hex'))
  )
    return false;
  if (
    inspectPendingEffects(db).some(
      (effect) => effect.taskRunId === runId || effect.taskRunId === '',
    )
  )
    return false;
  const coding = roomCodingTask(tx, root, (s) => createHash('sha256').update(s).digest('hex'));
  if (
    (coding?.task.devBotId === current.bot.id ? coding.task.id : undefined) !== current.codingTaskId
  )
    return false;
  const events = db
    .prepare('SELECT * FROM events WHERE aggregate_id=? ORDER BY sequence')
    .all(runId)
    .map((r) => fromEventRecord(eventRecordFromRow(r)));
  const run = replay(events);
  if (
    !isCreated(run) ||
    run.status !== 'running' ||
    run.cancellationCause !== null ||
    run.activeAttempt?.provider !== current.bot.provider ||
    run.activeAttempt.model !== current.bot.model
  )
    return false;
  if (command) {
    if (
      command.payload.attemptId !== run.activeAttempt.attemptId ||
      canonicalJson(command.payload.activation) !== canonicalJson(current.activation) ||
      command.expectedVersion !== run.version
    )
      return false;
    if (roomHostCounts(db, root.id).modelStarts >= 64) {
      freezeRoomHost(db, root.id, 'model_limit');
      return false;
    }
    return true;
  }
  const request = run.modelExecution?.lastRequest;
  return (
    !!request &&
    request.settlement === null &&
    request.attemptId === run.activeAttempt.attemptId &&
    canonicalJson(run.modelExecution?.activation) === canonicalJson(current.activation)
  );
}

/** Null is an ordinary run; false is a marked run whose current authority is not proved. */
export function roomHostPhysicalScope(
  db: DatabaseSync,
  host: RoomHostBinding,
  runId: string,
  at: number,
  selection?: true,
): RoomPhysicalScope | false | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_chat_turns'").get()) return null;
  const row = db.prepare('SELECT id FROM ocean_chat_turns WHERE task_run_id=?').get(runId);
  const turn = row && chatStorage(db).chatTurn(String(row['id']));
  if (!turn?.roomDelivery) return null;
  if (
    !db.isTransaction ||
    !Number.isFinite(at) ||
    !turn.activation ||
    at >= Date.parse(turn.activation.deadlineAt)
  )
    return false;
  const tx = roomAuthorityReads(db, host),
    rt = tx.roomTasks!;
  const input = rt.delivery(turn.roomDelivery.deliveryId),
    task = rt.task(turn.roomDelivery.taskId),
    root = input && rt.task(input.rootId);
  if (
    !task ||
    task.kind !== 'bot' ||
    !root ||
    root.kind !== 'root' ||
    task.rootId !== root.id ||
    !roomSliceAuthority(tx, root, task, at, (s) => createHash('sha256').update(s).digest('hex'))
  )
    return false;
  const state = db
    .prepare(
      "SELECT json_extract(payload,'$.attemptId') AS attempt FROM events WHERE aggregate_id=? AND type='attempt.started' ORDER BY sequence DESC LIMIT 1",
    )
    .get(runId);
  if (
    selection
      ? turn.status !== 'accepted'
      : !state || !rt.origin(turn.id, runId, String(state['attempt']), true)
  )
    return false;
  const active = state && rt.origin(turn.id, runId, String(state['attempt']), true);
  const subjects = roomTaskSubjects(
    tx,
    root,
    task,
    at,
    (s) => createHash('sha256').update(s).digest('hex'),
    runId,
  );
  if (!subjects) return false;
  const selected =
    root.rootPayload.mandate.codingTaskId && rt.codingTask(root.rootPayload.mandate.codingTaskId);
  if (
    (selected && selected.devBotId === turn.bot.id ? selected.id : undefined) !== turn.codingTaskId
  )
    return false;
  return {
    codingTaskId: turn.codingTaskId ?? null,
    turnId: turn.id,
    attemptId: active?.liveRun?.activeAttempt?.attemptId ?? null,
    ordinal: active?.liveRun?.modelExecution?.lastRequest.ordinal ?? 0,
    root,
    subjects,
    reviewer: !!selected && selected.reviewBotId === turn.bot.id,
  };
}

export function roomHostToolAllowed(
  db: DatabaseSync,
  host: RoomHostBinding,
  runId: string,
  now: number,
  admission?: ToolEffectAdmission,
): boolean {
  const scope = roomHostPhysicalScope(db, host, runId, now);
  if (scope === null) return true;
  if (
    !scope ||
    scope.reviewer ||
    !admission ||
    !admission.binding ||
    typeof admission.binding !== 'object' ||
    Array.isArray(admission.binding)
  )
    return false;
  if (!('roomBasis' in admission.binding)) return false;
  const basis = admission.binding.roomBasis;
  if (!Array.isArray(basis) || !basis.length) return false;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const valid =
    scope.subjects.every((issuer) =>
      basis.some(
        (b: unknown) =>
          object(b) &&
          b['chargedRunId'] === issuer.chargedRunId &&
          canonicalJson(b['subject']) === canonicalJson(issuer.subject) &&
          issuer.refs.some((r) => r.grantId === b['grantId'] && r.revision === b['revision']),
      ),
    ) &&
    basis.every(
      (b: unknown) =>
        object(b) &&
        scope.subjects.some(
          (issuer) =>
            b['chargedRunId'] === issuer.chargedRunId &&
            canonicalJson(b['subject']) === canonicalJson(issuer.subject) &&
            issuer.refs.some((r) => r.grantId === b['grantId'] && r.revision === b['revision']),
        ),
    );
  if (!valid) return false;
  if (!admitRoomCount(roomHostCounts(db, scope.root.id), 'tool_calls')) {
    freezeRoomHost(db, scope.root.id, 'tool_limit');
    return false;
  }
  return true;
}
