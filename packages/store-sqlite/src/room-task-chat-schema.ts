import type { DatabaseSync } from 'node:sqlite';
export function migrateRoomTaskChats(db: DatabaseSync): void {
  db.exec(`
  DROP INDEX ocean_chat_room_hold;
  CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
    WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL
      AND json_extract(payload,'$.roomDelivery') IS NULL;
  CREATE UNIQUE INDEX ocean_room_delivery_turn ON ocean_chat_turns(json_extract(payload,'$.roomDelivery.deliveryId'))
    WHERE json_extract(payload,'$.roomDelivery') IS NOT NULL;
  CREATE UNIQUE INDEX ocean_room_task_hold ON ocean_chat_turns(json_extract(payload,'$.roomDelivery.taskId'))
    WHERE status IN ('accepted','dispatching','prepared','uncertain') AND json_extract(payload,'$.roomDelivery') IS NOT NULL;
  CREATE TRIGGER ocean_room_turn_insert BEFORE INSERT ON ocean_chat_turns
  WHEN json_extract(NEW.payload,'$.roomDelivery') IS NOT NULL AND (
    json_extract(NEW.payload,'$.roomDelivery.version') IS NOT 1 OR NOT EXISTS(
    SELECT 1 FROM ocean_room_deliveries d JOIN ocean_room_tasks t ON t.id=d.to_task_id
    WHERE d.id=json_extract(NEW.payload,'$.roomDelivery.deliveryId')
      AND t.id=json_extract(NEW.payload,'$.roomDelivery.taskId')
      AND d.workspace_id=NEW.workspace_id AND d.room_id=NEW.room_id
      AND json_extract(NEW.payload,'$.workspaceId')=NEW.workspace_id
      AND json_extract(NEW.payload,'$.roomId')=NEW.room_id
      AND json_extract(NEW.payload,'$.id')=NEW.id
      AND json_extract(NEW.payload,'$.taskRunId')=NEW.task_run_id
      AND json_extract(NEW.payload,'$.status')=NEW.status
      AND json_extract(NEW.payload,'$.bot.id')=t.assignee_bot_id
      AND json_extract(NEW.payload,'$.bot.workspaceId')=NEW.workspace_id
      AND json_extract(NEW.payload,'$.inboundMessageId')=d.message_id
      AND json_extract(NEW.payload,'$.readThroughSeq')=d.seq))
  BEGIN SELECT RAISE(ABORT,'invalid room turn lineage'); END;
  CREATE TRIGGER ocean_room_turn_immutable BEFORE UPDATE ON ocean_chat_turns
  WHEN json_extract(NEW.payload,'$.roomDelivery') IS NOT json_extract(OLD.payload,'$.roomDelivery')
    OR (json_extract(OLD.payload,'$.roomDelivery') IS NOT NULL AND (
      NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.room_id IS NOT OLD.room_id
      OR NEW.task_run_id IS NOT OLD.task_run_id
      OR json_extract(NEW.payload,'$.id') IS NOT json_extract(OLD.payload,'$.id')
      OR json_extract(NEW.payload,'$.workspaceId') IS NOT json_extract(OLD.payload,'$.workspaceId')
      OR json_extract(NEW.payload,'$.roomId') IS NOT json_extract(OLD.payload,'$.roomId')
      OR json_extract(NEW.payload,'$.taskRunId') IS NOT json_extract(OLD.payload,'$.taskRunId')
      OR json_extract(NEW.payload,'$.bot') IS NOT json_extract(OLD.payload,'$.bot')
      OR json_extract(NEW.payload,'$.activation.identity') IS NOT json_extract(OLD.payload,'$.activation.identity')
      OR json_extract(NEW.payload,'$.modelBinding') IS NOT json_extract(OLD.payload,'$.modelBinding')
      OR json_extract(NEW.payload,'$.inboundMessageId') IS NOT json_extract(OLD.payload,'$.inboundMessageId')
      OR json_extract(NEW.payload,'$.readThroughSeq') IS NOT json_extract(OLD.payload,'$.readThroughSeq')
      OR json_extract(NEW.payload,'$.status') IS NOT NEW.status))
  BEGIN SELECT RAISE(ABORT,'immutable room turn lineage'); END;
  `);
}
