import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
import { ConversationService } from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function versionTwo() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  db.exec(readFileSync(new URL('./fixtures/ocean-schema-v2.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO ocean_workspace VALUES(1,'w','/project')");
  db.exec("INSERT INTO ocean_bots VALUES('1','w','dev','Dev','Role','deepseek','test',1)");
  db.exec("INSERT INTO ocean_rooms VALUES('2','w','direct','1')");
  db.exec("INSERT INTO ocean_members VALUES('w','2','1')");
  db.exec(
    "INSERT INTO ocean_messages VALUES('3','w','2',1,'user','1','saved in M1','2026-11-02T00:00:00Z')",
  );
  const s = new ConversationService({
    store: new SqliteConversationStore(db),
    clock: { now: () => new Date('2026-11-02T00:00:00Z') },
    nextId: () => {
      throw new Error('read only fixture');
    },
  });
  return { db, s };
}
it('preserves actual M1 message rows, profiles, memberships and receipts in schema 2→7', () => {
  const { db, s } = versionTwo();
  const tables = ['ocean_bots', 'ocean_rooms', 'ocean_members', 'ocean_receipts'];
  const snapshot = () =>
    tables.map((t) =>
      db
        .prepare(
          t === 'ocean_rooms'
            ? 'SELECT id,workspace_id,kind,bot_id FROM ocean_rooms'
            : 'SELECT * FROM ' + t,
        )
        .all(),
    );
  const before = snapshot();
  const history = s.history('w', '2');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '11',
  );
  expect(snapshot()).toEqual(before);
  expect(db.prepare('SELECT title FROM ocean_rooms').get()?.['title']).toBeNull();
  expect(s.history('w', '2')).toEqual(history);
  initializeSchema(db);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('leaves version 2 and its old messages intact when the migration fails partway', () => {
  const { db, s } = versionTwo();
  db.exec('CREATE TABLE ocean_chat_turns(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '2',
  );
  expect(s.history('w', '2')).toMatchObject({ value: [{ body: 'saved in M1' }] });
});
