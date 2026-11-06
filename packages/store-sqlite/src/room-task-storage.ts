import type { DatabaseSync } from 'node:sqlite';
import { validRoomTaskIdentity } from '@runnets/application';
import { canonicalJson } from '@runnets/domain';
import type {
  RoomTaskRecord,
  RoomDeliveryRecord,
  RoomTaskTransaction,
  RoomTaskRootPayload,
  RoomTaskMemberPin,
} from '@runnets/application';
import {
  validOwnerGrantReference,
  validOwnerPermission,
  validConversationText,
  type OwnerGrantReference,
} from '@runnets/domain';
import { readText, readInteger, readNullableText } from './rows.js';
import { readModelConnection } from './model-connection-storage.js';
import { readAuthorityGrant } from './service-authority-rows.js';
import { task as codingTask } from './coding-store.js';
import { restoreOriginStore } from './restore-origin.js';
import { roomTaskOrigin } from './room-task-origin.js';
type Row = Record<string, unknown>;
export function readRoomTask(db: DatabaseSync, id: string): RoomTaskRecord | null {
  const r = db.prepare('SELECT * FROM ocean_room_tasks WHERE id=?').get(id);
  if (!r) return null;
  const base = {
    version: 1 as const,
    revision: readInteger(r, 'revision'),
    id: readText(r, 'id'),
    workspaceId: readText(r, 'workspace_id'),
    roomId: readText(r, 'room_id'),
    rootId: readText(r, 'root_id'),
    status: readText(r, 'status') as RoomTaskRecord['status'],
  };
  if (
    r['version'] !== 1 ||
    !Number.isSafeInteger(base.revision) ||
    base.revision < 1 ||
    !['ready', 'waiting', 'paused', 'completed', 'stopped'].includes(base.status)
  )
    throw Error('invalid room task row');
  if (r['parent_id'] === null) {
    const p = JSON.parse(readText(r, 'root_payload')) as RoomTaskRootPayload;
    if (
      base.id !== base.rootId ||
      r['assignee_bot_id'] !== null ||
      r['last_delivery_seq'] !== 0 ||
      r['waiting_child_id'] !== null ||
      !p ||
      Object.keys(p).sort().join() !== 'limits,mandate,members,ownerId' ||
      !validConversationText(p.ownerId, 128) ||
      !p.mandate ||
      Object.keys(p.mandate).sort().join() !== 'codingTaskId,permissions,projectId' ||
      ![p.mandate.projectId, p.mandate.codingTaskId].every(
        (v) => v === null || validConversationText(v, 128),
      ) ||
      !Array.isArray(p.mandate.permissions) ||
      p.mandate.permissions.length > 256 ||
      !p.mandate.permissions.every(validOwnerPermission) ||
      canonicalJson(p.limits) !==
        canonicalJson({
          concurrentSlices: 2,
          totalSlices: 32,
          providerStarts: 64,
          toolCalls: 64,
        }) ||
      !Array.isArray(p.members) ||
      p.members.length < 1 ||
      p.members.length > 32 ||
      new Set(p.members.map((m: RoomTaskMemberPin) => m.botId)).size !== p.members.length ||
      !p.members.every(
        (m: RoomTaskMemberPin) =>
          validConversationText(m.botId, 128) &&
          Object.keys(m).sort().join() === 'botId,grantReferences,identity' &&
          Array.isArray(m.grantReferences) &&
          m.grantReferences.length <= 32 &&
          m.grantReferences.every(validOwnerGrantReference) &&
          new Set(m.grantReferences.map((r: OwnerGrantReference) => r.grantId)).size ===
            m.grantReferences.length &&
          m.identity?.source === 'connection' &&
          validRoomTaskIdentity(m.identity) &&
          Number.isSafeInteger(m.identity.connectionRevision) &&
          m.identity.connectionRevision > 0,
      )
    )
      throw Error('invalid room root payload');
    return {
      ...base,
      kind: 'root',
      parentId: null,
      assigneeBotId: null,
      lastDeliverySeq: 0,
      waitingChildId: null,
      rootPayload: p,
    };
  }
  if (
    base.id === base.rootId ||
    r['parent_id'] === base.id ||
    r['root_payload'] !== null ||
    !Number.isSafeInteger(r['last_delivery_seq']) ||
    Number(r['last_delivery_seq']) < 0 ||
    (base.status === 'waiting') !== (r['waiting_child_id'] !== null)
  )
    throw Error('invalid room bot task');
  return {
    ...base,
    kind: 'bot',
    parentId: readText(r, 'parent_id'),
    assigneeBotId: readText(r, 'assignee_bot_id'),
    lastDeliverySeq: readInteger(r, 'last_delivery_seq'),
    waitingChildId: readNullableText(r, 'waiting_child_id'),
    rootPayload: null,
  };
}
export function decodeRoomDelivery(r: Row): RoomDeliveryRecord {
  if (
    r['version'] !== 1 ||
    !['start', 'message', 'delegate'].includes(String(r['kind'])) ||
    !Number.isSafeInteger(r['position']) ||
    Number(r['position']) < 0 ||
    Number(r['position']) > 31 ||
    !Number.isSafeInteger(r['seq']) ||
    Number(r['seq']) < 1
  )
    throw Error('invalid room delivery row');
  return {
    version: 1,
    id: readText(r, 'id'),
    workspaceId: readText(r, 'workspace_id'),
    roomId: readText(r, 'room_id'),
    rootId: readText(r, 'root_id'),
    toTaskId: readText(r, 'to_task_id'),
    recipientBotId: readText(r, 'recipient_bot_id'),
    causeId: readText(r, 'cause_id'),
    requestKey: readText(r, 'request_key'),
    messageId: readText(r, 'message_id'),
    fromTaskId: readNullableText(r, 'from_task_id'),
    sourceTurnId: readNullableText(r, 'source_turn_id'),
    senderBotId: readNullableText(r, 'sender_bot_id'),
    kind: readText(r, 'kind') as RoomDeliveryRecord['kind'],
    seq: readInteger(r, 'seq'),
    position: readInteger(r, 'position'),
    sourceAttemptId: readNullableText(r, 'source_attempt_id'),
    state: readText(r, 'state') as RoomDeliveryRecord['state'],
  };
}
export function roomTaskStorage(db: DatabaseSync): RoomTaskTransaction {
  return {
    task: (id) => readRoomTask(db, id),
    deliveriesForReceipt: (key, _messageId) =>
      db
        .prepare('SELECT * FROM ocean_room_deliveries WHERE request_key=? ORDER BY position')
        .all(key)
        .map(decodeRoomDelivery),
    origin: (turn, run, attempt, live) => roomTaskOrigin(db, turn, run, attempt, live),
    grant: (id) => readAuthorityGrant(db, id),
    modelConnection: (id) => readModelConnection(db, id),
    codingTask: (id) =>
      codingTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
    restored: () => restoreOriginStore(db).origin() !== null,
    roomHold: (roomId) =>
      !!db
        .prepare(
          `SELECT 1 FROM ocean_room_tasks WHERE room_id=? AND id=root_id
      AND status IN ('ready','waiting','paused') UNION ALL
      SELECT 1 FROM ocean_chat_turns WHERE room_id=? AND json_extract(payload,'$.roomDelivery') IS NOT NULL
      AND status IN ('accepted','dispatching','prepared','uncertain') LIMIT 1`,
        )
        .get(roomId, roomId),
    pendingTransfer: (roomId) =>
      !!db
        .prepare(
          `SELECT 1 FROM ocean_room_deliveries d
      JOIN ocean_room_tasks r ON r.id=d.root_id
      JOIN ocean_room_tasks t ON t.id=d.to_task_id
      LEFT JOIN json_each(r.root_payload,'$.members') m ON json_extract(m.value,'$.botId')=d.recipient_bot_id
      WHERE d.room_id=? AND d.state IN ('queued','claimed','held')
      AND (d.state<>'queued' OR (r.status NOT IN ('completed','stopped') AND t.status NOT IN ('completed','stopped')))
      AND coalesce(json_extract(m.value,'$.identity.kind'),'unknown')<>'local' LIMIT 1`,
        )
        .get(roomId),
    putTask(t) {
      db.prepare('INSERT INTO ocean_room_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        t.id,
        t.workspaceId,
        t.roomId,
        t.rootId,
        t.parentId,
        t.assigneeBotId,
        t.status,
        t.version,
        t.revision,
        t.lastDeliverySeq,
        t.waitingChildId,
        t.rootPayload === null ? null : JSON.stringify(t.rootPayload),
      );
    },
    putDelivery(d) {
      db.prepare(
        'INSERT INTO ocean_room_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        d.id,
        d.workspaceId,
        d.roomId,
        d.rootId,
        d.toTaskId,
        d.recipientBotId,
        d.causeId,
        d.requestKey,
        d.messageId,
        d.fromTaskId,
        d.sourceTurnId,
        d.senderBotId,
        d.kind,
        d.seq,
        d.version,
        d.position,
        d.sourceAttemptId,
        d.state,
      );
    },
    waitFor(taskId, childId, expectedRevision) {
      const changed = db
        .prepare(
          "UPDATE ocean_room_tasks SET status='waiting',waiting_child_id=?,revision=revision+1 WHERE id=? AND revision=? AND status='ready'",
        )
        .run(childId, taskId, expectedRevision);
      if (changed.changes !== 1) throw Error('revision_conflict');
    },
  };
}
