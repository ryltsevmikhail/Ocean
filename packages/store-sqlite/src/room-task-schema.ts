import type { DatabaseSync } from 'node:sqlite';
import { migrateRoomTaskHistory } from './room-task-history-schema.js';
import { migrateRoomTaskChats } from './room-task-chat-schema.js';
export const ROOM_TASK_TABLES = ['ocean_room_tasks', 'ocean_room_deliveries'] as const;
/** v27 adds inert durable addressing; no runnable work is manufactured by migration. */
export function migrateRoomTasks(db: DatabaseSync): void {
  migrateRoomTaskHistory(db);
  db.exec(`
  CREATE TABLE ocean_room_tasks(
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    workspace_id TEXT NOT NULL CHECK(length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128),
    room_id TEXT NOT NULL CHECK(length(CAST(room_id AS BLOB)) BETWEEN 1 AND 128),
    root_id TEXT NOT NULL CHECK(length(CAST(root_id AS BLOB)) BETWEEN 1 AND 128),parent_id TEXT CHECK(parent_id IS NULL OR length(CAST(parent_id AS BLOB)) BETWEEN 1 AND 128),assignee_bot_id TEXT CHECK(assignee_bot_id IS NULL OR length(CAST(assignee_bot_id AS BLOB)) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK(status IN ('ready','waiting','paused','completed','stopped')),
    version INTEGER NOT NULL CHECK(version=1),revision INTEGER NOT NULL CHECK(revision>=1),
    last_delivery_seq INTEGER NOT NULL CHECK(last_delivery_seq>=0),waiting_child_id TEXT CHECK(waiting_child_id IS NULL OR length(CAST(waiting_child_id AS BLOB)) BETWEEN 1 AND 128),
    root_payload TEXT,
    UNIQUE(workspace_id,room_id,root_id,id),
    CHECK((id=root_id AND parent_id IS NULL AND assignee_bot_id IS NULL
      AND waiting_child_id IS NULL AND last_delivery_seq=0 AND root_payload IS NOT NULL
      AND json_valid(root_payload))
      OR (id<>root_id AND parent_id IS NOT NULL AND parent_id<>id AND assignee_bot_id IS NOT NULL
      AND root_payload IS NULL AND ((status='waiting')=(waiting_child_id IS NOT NULL)))),
    FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
    FOREIGN KEY(workspace_id,assignee_bot_id) REFERENCES ocean_bots(workspace_id,id),
    FOREIGN KEY(workspace_id,room_id,root_id,root_id) REFERENCES ocean_room_tasks(workspace_id,room_id,root_id,id),
    FOREIGN KEY(workspace_id,room_id,root_id,parent_id) REFERENCES ocean_room_tasks(workspace_id,room_id,root_id,id),
    FOREIGN KEY(workspace_id,room_id,root_id,waiting_child_id) REFERENCES ocean_room_tasks(workspace_id,room_id,root_id,id)
  ) STRICT;
  CREATE INDEX ocean_room_task_roots ON ocean_room_tasks(workspace_id,room_id,root_id);
  CREATE TRIGGER ocean_room_task_insert_wait BEFORE INSERT ON ocean_room_tasks
  WHEN NEW.waiting_child_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'inserted task cannot already wait'); END;
  CREATE TRIGGER ocean_room_task_parent BEFORE INSERT ON ocean_room_tasks
  WHEN NEW.id<>NEW.root_id AND (NOT EXISTS(
    SELECT 1 FROM ocean_room_tasks WHERE id=NEW.parent_id AND workspace_id=NEW.workspace_id
      AND room_id=NEW.room_id AND root_id=NEW.root_id) OR NOT EXISTS(
    SELECT 1 FROM ocean_room_tasks WHERE id=NEW.root_id AND id=root_id AND parent_id IS NULL
      AND workspace_id=NEW.workspace_id AND room_id=NEW.room_id))
  BEGIN SELECT RAISE(ABORT,'invalid room task parent'); END;
  CREATE TRIGGER ocean_room_task_immutable BEFORE UPDATE ON ocean_room_tasks
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.room_id IS NOT OLD.room_id
    OR NEW.root_id IS NOT OLD.root_id OR NEW.parent_id IS NOT OLD.parent_id
    OR NEW.assignee_bot_id IS NOT OLD.assignee_bot_id OR NEW.root_payload IS NOT OLD.root_payload
    OR NEW.version IS NOT OLD.version
  BEGIN SELECT RAISE(ABORT,'immutable room task'); END;
  CREATE TRIGGER ocean_room_task_wait BEFORE UPDATE OF waiting_child_id ON ocean_room_tasks
  WHEN NEW.waiting_child_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM ocean_room_tasks c WHERE c.id=NEW.waiting_child_id AND c.parent_id=NEW.id
      AND c.root_id=NEW.root_id AND c.workspace_id=NEW.workspace_id AND c.room_id=NEW.room_id)
  BEGIN SELECT RAISE(ABORT,'invalid waiting child'); END;
  CREATE TABLE ocean_room_deliveries(
    id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128),
    workspace_id TEXT NOT NULL CHECK(length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128),room_id TEXT NOT NULL CHECK(length(CAST(room_id AS BLOB)) BETWEEN 1 AND 128),
    root_id TEXT NOT NULL CHECK(length(CAST(root_id AS BLOB)) BETWEEN 1 AND 128),to_task_id TEXT NOT NULL CHECK(length(CAST(to_task_id AS BLOB)) BETWEEN 1 AND 128),
    recipient_bot_id TEXT NOT NULL CHECK(length(CAST(recipient_bot_id AS BLOB)) BETWEEN 1 AND 128),cause_id TEXT NOT NULL CHECK(length(CAST(cause_id AS BLOB)) BETWEEN 1 AND 128),
    request_key TEXT NOT NULL CHECK(length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),message_id TEXT NOT NULL CHECK(length(CAST(message_id AS BLOB)) BETWEEN 1 AND 128),
    from_task_id TEXT CHECK(from_task_id IS NULL OR length(CAST(from_task_id AS BLOB)) BETWEEN 1 AND 128),source_turn_id TEXT CHECK(source_turn_id IS NULL OR length(CAST(source_turn_id AS BLOB)) BETWEEN 1 AND 128),sender_bot_id TEXT CHECK(sender_bot_id IS NULL OR length(CAST(sender_bot_id AS BLOB)) BETWEEN 1 AND 128),
    kind TEXT NOT NULL CHECK(kind IN ('start','message','delegate')),
    seq INTEGER NOT NULL CHECK(seq>=1),version INTEGER NOT NULL CHECK(version=1),
    position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 31),source_attempt_id TEXT CHECK(source_attempt_id IS NULL OR length(CAST(source_attempt_id AS BLOB)) BETWEEN 1 AND 128),
    state TEXT NOT NULL CHECK(state IN ('queued','claimed','consumed','held')),
    UNIQUE(request_key,position),UNIQUE(request_key,recipient_bot_id),UNIQUE(to_task_id,message_id),
    CHECK((kind='start' AND cause_id=root_id AND from_task_id IS NULL AND source_turn_id IS NULL AND sender_bot_id IS NULL AND source_attempt_id IS NULL)
      OR (kind IN ('message','delegate') AND position=0 AND from_task_id IS NOT NULL
        AND source_turn_id IS NOT NULL AND sender_bot_id IS NOT NULL AND source_attempt_id IS NOT NULL)),
    FOREIGN KEY(workspace_id,room_id,root_id,to_task_id) REFERENCES ocean_room_tasks(workspace_id,room_id,root_id,id),
    FOREIGN KEY(workspace_id,room_id,root_id,from_task_id) REFERENCES ocean_room_tasks(workspace_id,room_id,root_id,id),
    FOREIGN KEY(room_id,source_turn_id) REFERENCES ocean_chat_turns(room_id,id),
    FOREIGN KEY(room_id,seq,message_id) REFERENCES ocean_messages(room_id,seq,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(request_key) REFERENCES ocean_receipts(request_id) DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX ocean_room_delivery_sequence ON ocean_room_deliveries(to_task_id,seq);
  CREATE TRIGGER ocean_room_delivery_target BEFORE INSERT ON ocean_room_deliveries
  WHEN NOT EXISTS(SELECT 1 FROM ocean_room_tasks t WHERE t.id=NEW.to_task_id
    AND t.workspace_id=NEW.workspace_id AND t.room_id=NEW.room_id AND t.root_id=NEW.root_id
    AND t.assignee_bot_id=NEW.recipient_bot_id
    AND t.parent_id=CASE WHEN NEW.kind='start' THEN NEW.root_id ELSE NEW.from_task_id END)
    OR (NEW.kind<>'start' AND NOT EXISTS(
      SELECT 1 FROM ocean_room_tasks s JOIN ocean_chat_turns c ON c.id=NEW.source_turn_id
      JOIN ocean_room_deliveries i ON i.id=NEW.cause_id
      WHERE s.id=NEW.from_task_id AND s.assignee_bot_id=NEW.sender_bot_id
        AND s.workspace_id=NEW.workspace_id AND s.room_id=NEW.room_id AND s.root_id=NEW.root_id
        AND c.workspace_id=NEW.workspace_id AND c.room_id=NEW.room_id
        AND json_extract(c.payload,'$.roomDelivery.taskId')=s.id
        AND json_extract(c.payload,'$.roomDelivery.deliveryId')=i.id
        AND json_extract(c.payload,'$.bot.id')=NEW.sender_bot_id
        AND i.to_task_id=s.id AND i.root_id=NEW.root_id))
  BEGIN SELECT RAISE(ABORT,'invalid room delivery lineage'); END;
  CREATE TRIGGER ocean_room_delivery_immutable BEFORE UPDATE ON ocean_room_deliveries
  WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.room_id IS NOT OLD.room_id
    OR NEW.root_id IS NOT OLD.root_id OR NEW.to_task_id IS NOT OLD.to_task_id
    OR NEW.recipient_bot_id IS NOT OLD.recipient_bot_id OR NEW.cause_id IS NOT OLD.cause_id
    OR NEW.request_key IS NOT OLD.request_key OR NEW.message_id IS NOT OLD.message_id
    OR NEW.from_task_id IS NOT OLD.from_task_id OR NEW.source_turn_id IS NOT OLD.source_turn_id
    OR NEW.sender_bot_id IS NOT OLD.sender_bot_id OR NEW.kind IS NOT OLD.kind OR NEW.seq IS NOT OLD.seq
    OR NEW.version IS NOT OLD.version OR NEW.position IS NOT OLD.position OR NEW.source_attempt_id IS NOT OLD.source_attempt_id
  BEGIN SELECT RAISE(ABORT,'immutable room delivery'); END;
  `);
  migrateRoomTaskChats(db);
}
