/* eslint-disable no-restricted-imports -- Test-only fixture for this package's own schema. */
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from '../src/schema.js';
import { omitModelConnectionSchema } from './model-schema.js';

function memory(): DatabaseSync {
  return openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
}

/**
 * Build a genuine schema-15 database with representative rows.
 *
 * The current (v16) schema is opened, rows that are legal under the v15 CHECK are
 * written, and only the objects migration 16 changes are rewritten to their real v15
 * DDL. `ocean_messages` is untouched because migration 16 no longer rebuilds it: its
 * v15 shape already allows a target-less user message.
 */
export function genuineSchema15(): { db: DatabaseSync; turns: unknown[]; messages: unknown[] } {
  const db = memory();
  omitModelConnectionSchema(db);
  db.exec(`
    INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES
      ('bot1','ws','dev','Dev','Role','test','test',1),
      ('bot2','ws','review','Review','Role','test','test',1);
    INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team'),('direct','ws','direct','bot1',NULL);
    INSERT INTO ocean_members VALUES('ws','room','bot1'),('ws','room','bot2'),('ws','direct','bot1');
  `);
  const payload = (id: string, room: string, status: string, extra: object = {}) =>
    JSON.stringify({
      id,
      workspaceId: 'ws',
      roomId: room,
      requestId: 'request-' + id,
      taskRunId: 'tr_' + id,
      inboundMessageId: 'note',
      readThroughSeq: 1,
      bot: {
        id: 'bot1',
        workspaceId: 'ws',
        handle: 'dev',
        name: 'Dev',
        role: 'Role',
        provider: 'test',
        model: 'test',
        profileVersion: 1,
      },
      status,
      text: status === 'prepared' ? 'prepared answer' : '',
      preparedVersion: status === 'prepared' ? 2 : null,
      stopReason: 'end_turn',
      ...extra,
    });
  for (const [id, room, status] of [
    ['turnC', 'room', 'completed'],
    ['turnR', 'room', 'uncertain'],
    ['turnP', 'direct', 'prepared'],
  ] as const)
    db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,NULL)').run(
      id,
      'ws',
      room,
      'tr_' + id,
      status,
      payload(id, room, status),
    );
  db.exec(`
    INSERT INTO ocean_messages VALUES
      ('note','ws','room',1,'user',NULL,'pre-boundary note','2026-11-04T00:00:00.000Z',NULL,NULL),
      ('reply','ws','room',2,'bot','bot1','attributed answer','2026-11-04T00:00:01.000Z','bot1','turnC'),
      ('notice','ws','room',3,'bot','bot1','review notice','2026-11-04T00:00:02.000Z','bot1','turnR');
    INSERT INTO ocean_reviews VALUES('review','ws','room','tr_turnR','turnR','notice','{}');
    UPDATE ocean_chat_turns SET review_id='review' WHERE id='turnR';
    INSERT INTO ocean_room_policies VALUES('room','text_only','review');
  `);
  // Rewrite only the objects migration 16 touches into their real schema-15 shape.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    DROP INDEX ocean_chat_room_hold;
    DROP INDEX ocean_chat_broadcast;
    DROP TRIGGER ocean_review_immutable;
    DROP TRIGGER ocean_review_turn;
    DROP TABLE ocean_broadcast_batches;
    CREATE TABLE ocean_chat_turns_v15 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('accepted','dispatching','prepared','completed','failed','uncertain','cancelled')),
      payload TEXT NOT NULL,
      review_id TEXT REFERENCES ocean_reviews(id),
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id)
    ) STRICT;
    INSERT INTO ocean_chat_turns_v15
      SELECT id,workspace_id,room_id,task_run_id,status,payload,review_id FROM ocean_chat_turns;
    DROP TABLE ocean_chat_turns;
    ALTER TABLE ocean_chat_turns_v15 RENAME TO ocean_chat_turns;
    CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
      WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL;
    CREATE TRIGGER ocean_review_immutable BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN OLD.review_id IS NOT NULL AND NEW.review_id IS NOT OLD.review_id
      BEGIN SELECT RAISE(ABORT,'continuation review is immutable'); END;
    CREATE TRIGGER ocean_review_turn BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN NEW.review_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM ocean_reviews WHERE id=NEW.review_id AND turn_id=NEW.id AND room_id=NEW.room_id)
      BEGIN SELECT RAISE(ABORT,'continuation review has wrong turn'); END;
    UPDATE meta SET value='15' WHERE key='schema_version';
  `);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    db,
    turns: db.prepare('SELECT id,status,payload,review_id FROM ocean_chat_turns ORDER BY id').all(),
    messages: db.prepare('SELECT * FROM ocean_messages ORDER BY seq').all(),
  };
}
export function triggers(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all()
    .map((row) => String(row['name']));
}
