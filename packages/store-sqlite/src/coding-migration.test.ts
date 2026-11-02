import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function old() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  db.exec(readFileSync(new URL('./fixtures/ocean-schema-v5.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO ocean_workspace VALUES(1,'ws','/project')");
  db.exec("INSERT INTO ocean_bots VALUES('bot','ws','dev','Dev','Role','test','test',1)");
  db.exec("INSERT INTO tool_invocations_v1 VALUES('legacy','shell','uncertain')");
  return db;
}
it('migrates frozen released schema 5 without granting bots rights or changing old rows/claims', () => {
  const db = old();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => String(r['name']));
  const before = new Map(
    tables
      .filter((n) => n !== 'meta')
      .map((n) => [n, db.prepare('SELECT * FROM "' + n + '"').all()]),
  );
  initializeSchema(db);
  for (const [name, rows] of before)
    expect(db.prepare('SELECT * FROM "' + name + '"').all()).toEqual(rows);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('8');
  expect(db.prepare('SELECT * FROM ocean_coding_tasks').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM ocean_coding_receipts').all()).toEqual([]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('rolls back a failed 5→7 migration and permits retry without losing legacy claims', () => {
  const db = old();
  db.exec('CREATE TABLE ocean_coding_receipts(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('5');
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_coding_tasks'").get(),
  ).toBeUndefined();
  expect(db.prepare('SELECT outcome FROM tool_invocations_v1').get()?.outcome).toBe('uncertain');
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  db.exec('DROP TABLE ocean_coding_receipts');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('8');
});
