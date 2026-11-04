import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  initializeSchema,
  openDatabase,
} from './schema.js';
import { broadcastStorage } from './broadcast-storage.js';
import { BROADCAST_TABLES } from './broadcast-schema.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
function memory(): DatabaseSync {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return db;
}
function tables(db: DatabaseSync): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string');
}
const batch = {
  version: 1 as const,
  id: 'batch1',
  workspaceId: 'ws',
  roomId: 'room',
  requestId: 'req',
  binding: '["Broadcast","ws","room","q",[]]',
  messageId: 'message1',
  boundarySeq: 2,
  recipients: [
    {
      botId: 'bot1',
      handle: 'dev',
      name: 'Dev',
      provider: 'test',
      model: 'test',
      turnId: 'turn1',
      runId: 'tr_turn1',
      position: 0,
    },
    {
      botId: 'bot2',
      handle: 'review',
      name: 'Review',
      provider: 'test',
      model: 'test',
      turnId: 'turn2',
      runId: 'tr_turn2',
      position: 1,
    },
  ],
  state: 'open' as const,
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
function seedConversation(db: DatabaseSync) {
  db.exec("INSERT INTO ocean_workspace VALUES(1,'ws','/project')");
  db.exec(
    "INSERT INTO ocean_bots VALUES('bot1','ws','dev','Dev','Role','test','test',1),('bot2','ws','review','Review','Role','test','test',1)",
  );
  db.exec("INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team')");
  db.exec("INSERT INTO ocean_members VALUES('ws','room','bot1'),('ws','room','bot2')");
  db.exec(
    "INSERT INTO ocean_messages VALUES('older','ws','room',1,'user',NULL,'older question','2026-11-04T00:00:00.000Z',NULL,NULL)",
  );
  db.exec(
    "INSERT INTO ocean_messages VALUES('message1','ws','room',2,'user',NULL,'broadcast question','2026-11-04T00:00:00.000Z',NULL,NULL)",
  );
  for (const [turnId, runId, position] of [
    ['turn1', 'tr_turn1', 0],
    ['turn2', 'tr_turn2', 1],
  ] as const) {
    db.prepare(
      `INSERT INTO ocean_chat_turns(id,workspace_id,room_id,task_run_id,status,payload,review_id)
       VALUES(?,?,?,?,'queued',?,NULL)`,
    ).run(
      turnId,
      'ws',
      'room',
      runId,
      JSON.stringify({
        id: turnId,
        workspaceId: 'ws',
        roomId: 'room',
        status: 'queued',
        taskRunId: runId,
        broadcast: { version: 1, batchId: 'batch1', position },
      }),
    );
  }
}
describe('broadcast migration 16', () => {
  it('creates the batch table and admits a target-less user message plus queued children', () => {
    const db = memory();
    expect(SCHEMA_VERSION).toBe(16);
    expect(tables(db)).toEqual(expect.arrayContaining([...BROADCAST_TABLES]));
    seedConversation(db);
    const storage = broadcastStorage(db);
    storage.putBatch(batch);
    expect(storage.batch('batch1')).toEqual(batch);
    expect(storage.batchByRequest('req')).toEqual(batch);
    expect(storage.batchForRoom('room')).toEqual(batch);
    expect(storage.batch('missing')).toBeNull();
    expect(storage.batchForRoom('unknown')).toBeNull();
    expect(storage.turns('batch1').map((turn) => turn.id)).toEqual(['turn1', 'turn2']);
    expect(
      db.prepare("SELECT target_bot_id FROM ocean_messages WHERE id='message1'").get(),
    ).toEqual({ target_bot_id: null });
  });
  it('permits only one open or paused batch per room but many closed ones', () => {
    const db = memory();
    seedConversation(db);
    const storage = broadcastStorage(db);
    storage.putBatch(batch);
    expect(() => storage.putBatch({ ...batch, id: 'batch2' })).toThrow();
    expect(() => storage.putBatch({ ...batch, state: 'paused', revision: 2 })).not.toThrow();
    db.exec(
      "INSERT INTO ocean_messages VALUES('message2','ws','room',3,'user',NULL,'again','2026-11-04T00:00:00.000Z',NULL,NULL)",
    );
    expect(() =>
      storage.putBatch({
        ...batch,
        id: 'batch2',
        state: 'completed',
        requestId: 'req2',
        messageId: 'message2',
        boundarySeq: 3,
      }),
    ).not.toThrow();
  });
  it('migrates a schema-15 profile preserving messages and turn rows', () => {
    const db = memory();
    seedConversation(db);
    // Recreate the accepted schema-15 shape: no batch table, old message/turn checks.
    db.exec(`DROP TABLE ocean_broadcast_batches;
      UPDATE meta SET value='15' WHERE key='schema_version';`);
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(tables(db)).toEqual(expect.arrayContaining([...BROADCAST_TABLES]));
    expect(db.prepare('SELECT count(*) AS n FROM ocean_broadcast_batches').get()).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT id,body,seq,target_bot_id FROM ocean_messages ORDER BY seq').all(),
    ).toEqual([
      { id: 'older', body: 'older question', seq: 1, target_bot_id: null },
      { id: 'message1', body: 'broadcast question', seq: 2, target_bot_id: null },
    ]);
    expect(db.prepare('SELECT id,status FROM ocean_chat_turns ORDER BY id').all()).toEqual([
      { id: 'turn1', status: 'queued' },
      { id: 'turn2', status: 'queued' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rolls back a failed migration and permits retry without losing legacy rows', () => {
    const db = memory();
    seedConversation(db);
    db.exec(`DROP TABLE ocean_broadcast_batches;
      UPDATE meta SET value='15' WHERE key='schema_version';
      CREATE TABLE ocean_broadcast_batches(collision TEXT);`);
    expect(() => initializeSchema(db)).toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '15',
    );
    expect(db.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n']).toBe(2);
    db.exec('DROP TABLE ocean_broadcast_batches');
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(broadcastStorage(db).turns('batch1')).toHaveLength(2);
    expect(broadcastStorage(db).batch('batch1')).toBeNull();
  });
  it('keeps bot messages targeted and direct messages target-guarded', () => {
    const db = memory();
    seedConversation(db);
    expect(() =>
      db.exec(
        "INSERT INTO ocean_messages VALUES('bad','ws','room',3,'bot',NULL,'answer','2026-11-04T00:00:00.000Z','bot1',NULL)",
      ),
    ).toThrow();
    db.exec("INSERT INTO ocean_rooms VALUES('direct','ws','direct','bot1',NULL)");
    db.exec("INSERT INTO ocean_members VALUES('ws','direct','bot1')");
    expect(() =>
      db.exec(
        "INSERT INTO ocean_messages VALUES('targetless','ws','direct',1,'user',NULL,'note','2026-11-04T00:00:00.000Z',NULL,NULL)",
      ),
    ).toThrow(/direct message requires a target/);
  });
});
