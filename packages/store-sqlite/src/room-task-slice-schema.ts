import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';
/** Replace only deliveries; v27 facts and JSON payload bytes remain untouched. */
export function migrateRoomTaskSlices(db: DatabaseSync): void {
  const schema = (name: string) =>
    readText(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)!, 'sql');
  const columns = db
    .prepare('PRAGMA table_info(ocean_room_deliveries)')
    .all()
    .map((r) => readText(r, 'name'))
    .join(',');
  const table = schema('ocean_room_deliveries')
    .replace('ocean_room_deliveries', 'ocean_room_deliveries_new')
    .replace("'start','message','delegate'", "'start','message','delegate','result'")
    .replace("kind IN ('message','delegate')", "kind IN ('message','delegate','result')");
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='ocean_room_deliveries' AND sql IS NOT NULL",
    )
    .all()
    .map((r) => readText(r, 'sql'));
  const immutable = schema('ocean_room_delivery_immutable');
  const external = ['ocean_addressed_message', 'ocean_room_turn_insert'].map(schema);
  const target = schema('ocean_room_delivery_target');
  db.exec('DROP TRIGGER ocean_addressed_message; DROP TRIGGER ocean_room_turn_insert;');
  db.exec(table);
  db.exec(`INSERT INTO ocean_room_deliveries_new(${columns}) SELECT ${columns} FROM ocean_room_deliveries;
    DROP TABLE ocean_room_deliveries; ALTER TABLE ocean_room_deliveries_new RENAME TO ocean_room_deliveries;`);
  for (const sql of [...indexes, immutable, ...external]) db.exec(sql);
  // The original v27 forward predicate stays byte-for-byte inside this branch.
  const predicate = target.slice(target.indexOf('WHEN ') + 5, target.indexOf('\n  BEGIN'));
  db.exec(`CREATE TRIGGER ocean_room_delivery_target BEFORE INSERT ON ocean_room_deliveries
    WHEN (NEW.kind<>'result' AND (${predicate})) OR (NEW.kind='result' AND NOT EXISTS(
      SELECT 1 FROM ocean_room_deliveries edge
      JOIN ocean_room_tasks p ON p.id=edge.from_task_id
      JOIN ocean_room_tasks b ON b.id=edge.to_task_id
      JOIN ocean_chat_turns yielded ON yielded.id=edge.source_turn_id
      JOIN ocean_chat_turns final ON final.id=NEW.source_turn_id
      JOIN ocean_room_deliveries input ON input.id=json_extract(final.payload,'$.roomDelivery.deliveryId')
      JOIN ocean_messages m ON m.id=NEW.message_id
      WHERE edge.id=NEW.cause_id AND edge.kind='delegate' AND edge.root_id=NEW.root_id
      AND p.id=NEW.to_task_id AND p.waiting_child_id=b.id AND p.status='waiting'
      AND b.id=NEW.from_task_id AND b.status='completed' AND b.parent_id=p.id AND b.assignee_bot_id=NEW.sender_bot_id
      AND p.assignee_bot_id=NEW.recipient_bot_id AND b.root_id=p.root_id AND b.root_id=NEW.root_id
      AND p.workspace_id=NEW.workspace_id AND p.room_id=NEW.room_id
      AND b.workspace_id=NEW.workspace_id AND b.room_id=NEW.room_id
      AND edge.workspace_id=NEW.workspace_id AND edge.room_id=NEW.room_id
      AND yielded.status='completed' AND json_extract(yielded.payload,'$.roomSliceDisposition')='yielded'
      AND json_extract(yielded.payload,'$.roomHandoff.deliveryId')=edge.id
      AND json_extract(yielded.payload,'$.roomHandoff.childTaskId')=b.id
      AND json_extract(final.payload,'$.roomDelivery.taskId')=b.id
      AND final.workspace_id=NEW.workspace_id AND final.room_id=NEW.room_id
      AND input.to_task_id=b.id AND input.root_id=b.root_id AND input.state='consumed'
      AND m.id='reply_'||final.id AND m.seq=NEW.seq AND m.turn_id=final.id
      AND m.workspace_id=NEW.workspace_id AND m.room_id=NEW.room_id
      AND m.author='bot' AND m.author_bot_id=b.assignee_bot_id AND m.target_bot_id=b.assignee_bot_id
      AND m.body=json_extract(final.payload,'$.text') AND final.status='completed'
      AND EXISTS(SELECT 1 FROM events e WHERE e.aggregate_id=final.task_run_id AND e.type='task_run.succeeded'
        AND e.sequence=(SELECT max(sequence) FROM events WHERE aggregate_id=final.task_run_id)
        AND json_extract(e.payload,'$.attemptId')=NEW.source_attempt_id
        AND e.causation_id='cm_'||final.task_run_id||'_Complete_'||(json_extract(final.payload,'$.preparedVersion')+1))
      AND json_extract(final.payload,'$.roomSliceDisposition') IS NULL))
    BEGIN SELECT RAISE(ABORT,'invalid room delivery lineage'); END;
    CREATE UNIQUE INDEX ocean_room_assignment_result ON ocean_room_deliveries(from_task_id) WHERE kind='result';`);
  const turnImmutable = schema('ocean_room_turn_immutable').replaceAll(
    '$.activation.identity',
    '$.activation',
  );
  db.exec('DROP TRIGGER ocean_room_turn_immutable;');
  db.exec(turnImmutable);
  for (const operation of ['INSERT', 'UPDATE'])
    db.exec(`
    CREATE TRIGGER ocean_room_slice_${operation.toLowerCase()} BEFORE ${operation} ON ocean_chat_turns
    WHEN (json_type(NEW.payload,'$.roomDelivery') IS NOT NULL AND (
      json_type(NEW.payload,'$.roomDelivery') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(NEW.payload,'$.roomDelivery'))<>3
      OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.roomDelivery') WHERE key NOT IN ('version','taskId','deliveryId'))
      OR json_extract(NEW.payload,'$.roomDelivery.version') IS NOT 1
      OR json_type(NEW.payload,'$.roomDelivery.taskId') IS NOT 'text'
      OR json_type(NEW.payload,'$.roomDelivery.deliveryId') IS NOT 'text'))
    OR (json_type(NEW.payload,'$.roomHandoff') IS NOT NULL AND (
      json_type(NEW.payload,'$.roomHandoff') IS NOT 'object'
      OR (SELECT count(*) FROM json_each(NEW.payload,'$.roomHandoff'))<>8
      OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.roomHandoff') WHERE key NOT IN ('version','turnId','taskRunId','attemptId','callId','childTaskId','deliveryId','expectedRunVersion'))
      OR json_type(NEW.payload,'$.roomHandoff.expectedRunVersion') IS NOT 'integer'
      OR json_extract(NEW.payload,'$.roomHandoff.expectedRunVersion') NOT BETWEEN 1 AND 9007199254740990
      OR json_type(NEW.payload,'$.roomHandoff.callId') IS NOT 'text'
      OR length(CAST(json_extract(NEW.payload,'$.roomHandoff.callId') AS BLOB)) NOT BETWEEN 1 AND 512
      OR NEW.status NOT IN ('dispatching','uncertain','completed')
      OR (NEW.status='completed' AND json_extract(NEW.payload,'$.roomSliceDisposition') IS NOT 'yielded')
      OR json_extract(NEW.payload,'$.roomDelivery.version') IS NOT 1
      OR json_extract(NEW.payload,'$.roomHandoff.version') IS NOT 1
      OR json_extract(NEW.payload,'$.roomHandoff.turnId') IS NOT NEW.id
      OR json_extract(NEW.payload,'$.roomHandoff.taskRunId') IS NOT NEW.task_run_id
      OR NOT EXISTS(SELECT 1 FROM ocean_room_deliveries d JOIN ocean_room_tasks t ON t.id=d.from_task_id
        WHERE d.id=json_extract(NEW.payload,'$.roomHandoff.deliveryId') AND d.kind='delegate'
        AND d.source_turn_id=NEW.id AND d.source_attempt_id=json_extract(NEW.payload,'$.roomHandoff.attemptId')
        AND d.to_task_id=json_extract(NEW.payload,'$.roomHandoff.childTaskId')
        AND d.from_task_id=json_extract(NEW.payload,'$.roomDelivery.taskId')
        AND d.cause_id=json_extract(NEW.payload,'$.roomDelivery.deliveryId'))))
      OR (json_type(NEW.payload,'$.roomSliceDisposition') IS NOT NULL AND (
        json_extract(NEW.payload,'$.roomSliceDisposition') IS NOT 'yielded' OR NEW.status IS NOT 'completed'
        OR json_type(NEW.payload,'$.roomHandoff') IS NULL OR json_extract(NEW.payload,'$.text') IS NOT ''
        OR json_type(NEW.payload,'$.preparedVersion') IS NOT 'null'))
    BEGIN SELECT RAISE(ABORT,'invalid room slice'); END;`);
  db.exec(`CREATE TRIGGER ocean_room_no_handoff_final BEFORE INSERT ON ocean_messages
    WHEN NEW.author='bot' AND NEW.author_bot_id=NEW.target_bot_id AND EXISTS(
      SELECT 1 FROM ocean_chat_turns c WHERE c.id=NEW.turn_id
      AND json_extract(c.payload,'$.roomHandoff') IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'handoff cannot publish final'); END;`);
  db.exec(`CREATE TRIGGER ocean_room_proof_immutable BEFORE UPDATE ON ocean_chat_turns
    WHEN (json_type(OLD.payload,'$.roomHandoff') IS NOT NULL AND json_extract(NEW.payload,'$.roomHandoff') IS NOT json_extract(OLD.payload,'$.roomHandoff'))
    OR (json_extract(OLD.payload,'$.roomDelivery') IS NOT NULL
      AND json_extract(OLD.payload,'$.roomHandoff') IS NULL AND OLD.status IN ('prepared','completed')
      AND (json_extract(NEW.payload,'$.text') IS NOT json_extract(OLD.payload,'$.text')
        OR json_extract(NEW.payload,'$.preparedVersion') IS NOT json_extract(OLD.payload,'$.preparedVersion')
        OR json_extract(NEW.payload,'$.stopReason') IS NOT json_extract(OLD.payload,'$.stopReason')))
    OR (json_type(OLD.payload,'$.roomSliceDisposition') IS NOT NULL AND json_extract(NEW.payload,'$.roomSliceDisposition') IS NOT json_extract(OLD.payload,'$.roomSliceDisposition'))
    BEGIN SELECT RAISE(ABORT,'immutable room proof'); END;`);
}
