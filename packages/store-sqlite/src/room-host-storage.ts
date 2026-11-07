import { createHash } from 'node:crypto';
import { canonicalJson, validConversationText, taskRunId } from '@runnets/domain';
import type { ProfileRebindRecord, RestoreOrigin } from '@runnets/domain';
import type { RoomHostScope } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { restoreOriginStore } from './restore-origin.js';
import { activeRebind } from './restoration-authority.js';

export type RoomHostBinding = () => RoomHostScope | null;
export function createRoomHostBinding(db: DatabaseSync) {
  let bound: RoomHostScope | null = null;
  let fingerprint: string | null = null;
  const facts = () => ({ origin: restoreOriginStore(db).origin(), active: activeRebind(db) });
  return {
    bind(
      scope: RoomHostScope,
      verified: { origin: RestoreOrigin | null; active: ProfileRebindRecord | null },
    ): void {
      if (
        bound ||
        !validConversationText(scope.ownerId, 128) ||
        (scope.epochId !== null && !validConversationText(scope.epochId, 128))
      )
        throw Error('invalid_room_host');
      const current = facts();
      if (
        canonicalJson(current) !== canonicalJson(verified) ||
        (scope.epochId === null
          ? current.origin !== null || current.active !== null
          : !current.origin ||
            !current.active ||
            current.active.preview.epochId !== scope.epochId ||
            current.active.preview.ownerId !== scope.ownerId)
      )
        throw Error('invalid_room_host');
      bound = Object.freeze({ ...scope });
      fingerprint = canonicalJson(current);
    },
    current(): RoomHostScope | null {
      if (!db.isTransaction || !bound) return null;
      try {
        return canonicalJson(facts()) === fingerprint ? bound : null;
      } catch {
        return null;
      }
    },
  };
}
export function migrateRoomHost(db: DatabaseSync): void {
  db.exec(`ALTER TABLE ocean_room_tasks ADD COLUMN host_scope TEXT DEFAULT NULL
    CHECK(host_scope IS NULL OR (id=root_id AND json_valid(host_scope)));
    CREATE TRIGGER ocean_room_host_immutable BEFORE UPDATE OF host_scope ON ocean_room_tasks
    WHEN NEW.host_scope IS NOT OLD.host_scope
    BEGIN SELECT RAISE(ABORT,'immutable room host'); END;
    CREATE TRIGGER ocean_room_coding_immutable BEFORE UPDATE ON ocean_chat_turns
    WHEN json_extract(OLD.payload,'$.roomDelivery') IS NOT NULL AND json_extract(NEW.payload,'$.codingTaskId') IS NOT json_extract(OLD.payload,'$.codingTaskId')
    BEGIN SELECT RAISE(ABORT,'immutable room coding assignment'); END;`);
}

/** Same-snapshot durable counts; admitted work is never refunded after uncertainty. */
export function roomHostCounts(db: DatabaseSync, rootId: string) {
  const base = `FROM ocean_chat_turns t JOIN ocean_room_tasks k ON k.id=json_extract(t.payload,'$.roomDelivery.taskId') WHERE k.root_id=? AND t.workspace_id=k.workspace_id AND t.room_id=k.room_id`;
  const count = (sql: string) => Number(db.prepare(sql).get(rootId)?.['n'] ?? 0);
  return {
    active: count(
      `SELECT count(*) AS n ${base} AND t.status IN ('accepted','dispatching','prepared','uncertain')`,
    ),
    slices: count(`SELECT count(*) AS n ${base}`),
    modelStarts: count(
      `SELECT count(*) AS n FROM events e JOIN ocean_chat_turns t ON t.task_run_id=e.aggregate_id JOIN ocean_room_tasks k ON k.id=json_extract(t.payload,'$.roomDelivery.taskId') WHERE k.root_id=? AND e.type='attempt.model_request_started' AND t.workspace_id=k.workspace_id AND t.room_id=k.room_id`,
    ),
    toolCalls:
      count(
        `SELECT count(*) AS n FROM tool_invocations_v2 j JOIN ocean_chat_turns t ON t.task_run_id=j.task_run_id JOIN ocean_room_tasks k ON k.id=json_extract(t.payload,'$.roomDelivery.taskId') WHERE k.root_id=? AND t.workspace_id=k.workspace_id AND t.room_id=k.room_id`,
      ) +
      count(
        `SELECT count(*) AS n FROM ocean_receipts r JOIN ocean_room_deliveries d ON d.request_key=r.request_id WHERE d.root_id=? AND d.kind IN ('message','delegate')`,
      ) +
      count(
        `SELECT count(*) AS n FROM ocean_receipts WHERE json_extract(reply,'$.kind')='room_task_state' AND json_extract(reply,'$.data.rootId')=?`,
      ),
  };
}

import type { RoomTaskRootView, RoomTaskRow } from '@runnets/application';
import { readRoomTask, decodeRoomDelivery } from './room-task-storage.js';
import { decodeChatTurn } from './chat-storage.js';
import { roomRuntimeReads } from './room-runtime-reads.js';
import { completionSummary, stepCommand, roomCompleteEvidence } from '@runnets/application';
import { roomTaskSliceStorage } from './room-task-slice-storage.js';
export function roomHostProjection(db: DatabaseSync, rootId: string): RoomTaskRootView | null {
  const root = readRoomTask(db, rootId);
  if (!root || root.kind !== 'root') return null;
  const tasks = db
    .prepare(
      'SELECT id FROM ocean_room_tasks WHERE workspace_id=? AND room_id=? AND root_id=? ORDER BY id COLLATE BINARY',
    )
    .all(root.workspaceId, root.roomId, rootId)
    .map((r) => readRoomTask(db, String(r['id']))!);
  const deliveries = db
    .prepare(
      'SELECT * FROM ocean_room_deliveries WHERE workspace_id=? AND room_id=? AND root_id=? ORDER BY id COLLATE BINARY',
    )
    .all(root.workspaceId, root.roomId, rootId)
    .map(decodeRoomDelivery);
  const turns = db
    .prepare(
      `SELECT c.* FROM ocean_chat_turns c JOIN ocean_room_tasks t ON t.id=json_extract(c.payload,'$.roomDelivery.taskId') WHERE t.root_id=? AND c.workspace_id=t.workspace_id AND c.room_id=t.room_id ORDER BY c.id COLLATE BINARY`,
    )
    .all(rootId)
    .map(decodeChatTurn);
  const savedFence = db
    .prepare(
      `SELECT request_id,reply FROM ocean_receipts WHERE json_extract(reply,'$.data.rootId')=? AND json_extract(reply,'$.kind') IN ('room_task_fence','room_task_stop') AND json_extract(reply,'$.kind')=CASE WHEN (SELECT status FROM ocean_room_tasks WHERE id=?)='stopped' THEN 'room_task_stop' ELSE 'room_task_fence' END ORDER BY rowid DESC LIMIT 1`,
    )
    .get(rootId, rootId);
  const fence = root.status === 'stopped' || root.status === 'paused' ? root.status : null;
  const reads = roomRuntimeReads(db, Date.now);
  const rows: RoomTaskRow[] = tasks.map((t) => ({
    type: 'task',
    id: t.id,
    parentId: t.parentId,
    botId: t.assigneeBotId,
    status: t.status,
    waitingChildId: t.waitingChildId,
    hold: fence ?? (t.status === 'waiting' ? 'waiting' : null),
  }));
  rows.push(
    ...deliveries.map((d): RoomTaskRow => ({
      type: 'delivery',
      id: d.id,
      kind: d.kind,
      fromTaskId: d.fromTaskId,
      toTaskId: d.toTaskId,
      causeId: d.causeId,
      state: d.state,
      messageId: d.messageId,
      seq: d.seq,
      hold: fence ?? (d.state === 'queued' ? 'queued' : d.state === 'held' ? 'unknown' : null),
    })),
  );
  rows.push(
    ...turns.map((t): RoomTaskRow => {
      let run;
      try {
        run = reads.run({
          workspaceId: root.workspaceId,
          roomId: root.roomId,
          runId: t.taskRunId,
        });
      } catch {
        run = null;
      }
      const command =
        t.preparedVersion !== null
          ? stepCommand(
              taskRunId(t.taskRunId),
              'Complete',
              { attemptId: t.taskRunId + '_at_0001', summary: completionSummary(t.text) },
              t.preparedVersion,
            )
          : null;
      const proof = command && roomTaskSliceStorage(db).completeEvidence(command);
      const resultProved = !!command && !!proof && roomCompleteEvidence(proof, command);
      return {
        type: 'slice',
        taskId: t.roomDelivery!.taskId,
        deliveryId: t.roomDelivery!.deliveryId,
        runId: t.taskRunId,
        turnId: t.id,
        turnStatus: t.status,
        taskStatus: run?.taskStatus ?? 'unknown',
        version: run?.version ?? 0,
        disposition: t.roomSliceDisposition ?? null,
        resultMessageId:
          t.roomSliceDisposition === 'yielded' || !resultProved
            ? null
            : (run?.resultMessageId ?? null),
        pendingDecisionIds: (run?.pendingDecisionIds ?? []).slice(0, 200),
        hold:
          fence ??
          (!run ||
          t.status === 'uncertain' ||
          run.taskStatus === 'reconciling' ||
          run.taskStatus === 'cancelling' ||
          (t.status === 'completed' && t.roomSliceDisposition !== 'yielded' && !resultProved)
            ? 'unknown'
            : null),
      };
    }),
  );
  const saved: unknown = savedFence ? JSON.parse(String(savedFence['reply'])) : null;
  const data = saved && typeof saved === 'object' && 'data' in saved ? saved.data : null;
  const code = data && typeof data === 'object' && 'code' in data ? data.code : null;
  const savedCode = [
    'queued',
    'waiting',
    'stopped',
    'paused',
    'unknown',
    'authority_denied',
    'slice_limit',
    'model_limit',
    'tool_limit',
    'duplicate_exchange',
  ].find((item) => item === code) as Exclude<RoomTaskRow['hold'], null> | undefined;
  return {
    decisionMark: JSON.stringify(
      db
        .prepare(
          `SELECT d.decisionId,d.runId,d.revision FROM ocean_owner_decisions d JOIN ocean_chat_turns c ON c.task_run_id=d.runId AND c.workspace_id=d.workspaceId AND c.room_id=d.roomId JOIN ocean_room_tasks t ON t.id=json_extract(c.payload,'$.roomDelivery.taskId') WHERE t.root_id=? AND t.workspace_id=c.workspace_id AND t.room_id=c.room_id ORDER BY d.decisionId COLLATE BINARY`,
        )
        .all(rootId),
    ),
    workspaceId: root.workspaceId,
    roomId: root.roomId,
    rootId,
    status: root.status,
    revision: root.revision,
    fenceReason: fence
      ? {
          id:
            data && typeof data === 'object' && 'id' in data && typeof data.id === 'string'
              ? data.id
              : savedFence
                ? String(savedFence['request_id'])
                : root.id,
          code: savedCode ?? fence,
        }
      : null,
    counts: roomHostCounts(db, rootId),
    rows,
    nextPage: null,
  };
}

/** A stable local fence is committed by the same authority transaction that refused new I/O. */
export function freezeRoomHost(
  db: DatabaseSync,
  rootId: string,
  code: 'tool_limit' | 'model_limit',
): void {
  const root = readRoomTask(db, rootId);
  if (!db.isTransaction || !root || root.kind !== 'root' || root.status !== 'ready') return;
  const id = 'room-fence/v2:' + createHash('sha256').update(rootId).digest('hex'),
    key = '\0' + id;
  const data = {
    workspaceId: root.workspaceId,
    roomId: root.roomId,
    rootId,
    id,
    code,
    revision: root.revision + 1,
  };
  const binding = canonicalJson(['RoomTaskFence/v1', root.id, code]),
    reply = JSON.stringify({ kind: 'room_task_fence', data });
  const prior = db.prepare('SELECT binding,reply FROM ocean_receipts WHERE request_id=?').get(key);
  if (
    prior &&
    (prior['binding'] !== binding ||
      canonicalJson(JSON.parse(String(prior['reply']))) !== canonicalJson(JSON.parse(reply)))
  )
    throw Error('request_conflict');
  if (
    db
      .prepare(
        "UPDATE ocean_room_tasks SET status='paused',revision=revision+1 WHERE id=? AND revision=? AND status='ready'",
      )
      .run(root.id, root.revision).changes !== 1
  )
    throw Error('revision_conflict');
  if (!prior) db.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)').run(key, binding, reply);
}
