import type { RoomTaskList, RoomTaskListPage } from '@runnets/application';
import { canonicalJson } from '@runnets/domain';
import type { DatabaseSync } from 'node:sqlite';
import type { RoomHostBinding } from './room-host-storage.js';
import { readRoomTask } from './room-task-storage.js';
import { readInteger, readText } from './rows.js';
/** One canonical owner message per root, bounded before decoding payloads; never wakes work. */
export function roomTaskList(
  db: DatabaseSync,
  host: RoomHostBinding,
  input: RoomTaskList,
  ownerId: string,
): RoomTaskListPage {
  const limit = input.limit ?? 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (input.beforeSeq !== undefined &&
      (!Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1))
  )
    throw Error('invalid_input');
  if (
    !db
      .prepare('SELECT 1 FROM ocean_rooms WHERE workspace_id=? AND id=?')
      .get(input.workspaceId, input.roomId)
  )
    throw Error('unknown_room');
  const rows = db
    .prepare(
      `
    WITH starts AS (
      SELECT r.id, min(d.seq) AS start_seq
      FROM ocean_room_tasks r JOIN ocean_room_deliveries d
        ON d.root_id=r.id AND d.workspace_id=r.workspace_id AND d.room_id=r.room_id
      JOIN ocean_messages m ON m.workspace_id=d.workspace_id AND m.room_id=d.room_id
        AND m.seq=d.seq AND m.id=d.message_id AND m.author='user'
      WHERE r.workspace_id=? AND r.room_id=? AND r.id=r.root_id
        AND json_extract(r.root_payload,'$.ownerId')=?
        AND d.kind='start' AND d.position=0 AND d.cause_id=r.id
      GROUP BY r.id
    )
    SELECT s.id, s.start_seq, m.id AS start_message_id FROM starts s
    JOIN ocean_messages m ON m.workspace_id=? AND m.room_id=? AND m.seq=s.start_seq
    WHERE (? IS NULL OR s.start_seq<?) ORDER BY s.start_seq DESC LIMIT ?
  `,
    )
    .all(
      input.workspaceId,
      input.roomId,
      ownerId,
      input.workspaceId,
      input.roomId,
      input.beforeSeq ?? null,
      input.beforeSeq ?? null,
      limit + 1,
    );
  const current = host();
  const roots: RoomTaskListPage['roots'] = rows.slice(0, limit).map((row) => {
    const root = readRoomTask(db, readText(row, 'id'));
    if (!root || root.kind !== 'root') throw Error('invalid room root');
    return {
      rootId: root.id,
      startMessageId: readText(row, 'start_message_id'),
      startSeq: readInteger(row, 'start_seq'),
      status: root.status,
      revision: root.revision,
      authority:
        root.hostScope && current && canonicalJson(root.hostScope) === canonicalJson(current)
          ? 'current'
          : 'historical',
    };
  });
  return {
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    roots,
    nextBeforeSeq: rows.length > limit ? roots.at(-1)!.startSeq : null,
  };
}
