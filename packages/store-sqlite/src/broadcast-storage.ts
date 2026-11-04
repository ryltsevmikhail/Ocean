import type { DatabaseSync } from 'node:sqlite';
import { isBroadcastBatch, type BroadcastBatch, type ChatTurn } from '@runnets/domain';
import { decodeChatTurn } from './chat-storage.js';
import { readInteger, readText } from './rows.js';

export interface BroadcastStorage {
  batch(id: string): BroadcastBatch | null;
  batchByRequest(requestId: string): BroadcastBatch | null;
  batchForRoom(roomId: string): BroadcastBatch | null;
  batches(roomId: string, limit: number): readonly BroadcastBatch[];
  openBatches(): readonly BroadcastBatch[];
  putBatch(batch: BroadcastBatch): void;
  turns(batchId: string): readonly ChatTurn[];
}
const BATCH_TURNS = `WHERE json_extract(payload,'$.broadcast.version')=1
  AND json_extract(payload,'$.broadcast.batchId')=?`;
function decode(row: Record<string, unknown>): BroadcastBatch {
  const recipients: unknown = JSON.parse(readText(row, 'recipients'));
  const value = {
    version: 1,
    id: readText(row, 'id'),
    workspaceId: readText(row, 'workspace_id'),
    roomId: readText(row, 'room_id'),
    requestId: readText(row, 'request_id'),
    binding: readText(row, 'binding'),
    messageId: readText(row, 'message_id'),
    boundarySeq: readInteger(row, 'boundary_seq'),
    recipients,
    state: readText(row, 'state'),
    revision: readInteger(row, 'revision'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  };
  if (!isBroadcastBatch(value)) throw Error('invalid_broadcast_batch');
  return value;
}
/** Batch, frozen recipient and child-turn persistence; always inside the caller's transaction. */
export function broadcastStorage(db: DatabaseSync): BroadcastStorage {
  const one = (row: Record<string, unknown> | undefined) => (row ? decode(row) : null);
  return {
    batch: (id) => one(db.prepare('SELECT * FROM ocean_broadcast_batches WHERE id=?').get(id)),
    batchByRequest: (requestId) =>
      one(db.prepare('SELECT * FROM ocean_broadcast_batches WHERE request_id=?').get(requestId)),
    batchForRoom: (roomId) =>
      one(
        db
          .prepare(
            "SELECT * FROM ocean_broadcast_batches WHERE room_id=? AND state IN ('open','paused')",
          )
          .get(roomId),
      ),
    batches: (roomId, limit) =>
      db
        .prepare(
          'SELECT * FROM ocean_broadcast_batches WHERE room_id=? ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(roomId, limit)
        .map((row) => decode(row as Record<string, unknown>)),
    openBatches: () =>
      db
        .prepare(
          "SELECT * FROM ocean_broadcast_batches WHERE state IN ('open','paused') ORDER BY created_at, id",
        )
        .all()
        .map((row) => decode(row as Record<string, unknown>)),
    putBatch(batch) {
      db.prepare(
        `INSERT INTO ocean_broadcast_batches
          (id,workspace_id,room_id,request_id,binding,message_id,boundary_seq,recipients,state,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at`,
      ).run(
        batch.id,
        batch.workspaceId,
        batch.roomId,
        batch.requestId,
        batch.binding,
        batch.messageId,
        batch.boundarySeq,
        JSON.stringify(batch.recipients),
        batch.state,
        batch.revision,
        batch.createdAt,
        batch.updatedAt,
      );
    },
    turns: (batchId) =>
      db
        .prepare(
          `SELECT * FROM ocean_chat_turns ${BATCH_TURNS}
          ORDER BY json_extract(payload,'$.broadcast.position'), id`,
        )
        .all(batchId)
        .map((row) => decodeChatTurn(row as Record<string, unknown>)),
  };
}
