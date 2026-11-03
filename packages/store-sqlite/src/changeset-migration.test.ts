import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function old() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  db.exec(readFileSync(new URL('./fixtures/ocean-schema-v6.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO ocean_workspace VALUES(1,'ws','/project')");
  db.exec("INSERT INTO ocean_bots VALUES('dev','ws','dev','Dev','Role','test','test',1)");
  db.exec("INSERT INTO ocean_bots VALUES('review','ws','review','Review','Role','test','test',1)");
  db.exec("INSERT INTO ocean_rooms VALUES('dev-room','ws','direct','dev',NULL)");
  db.exec("INSERT INTO ocean_rooms VALUES('review-room','ws','direct','review',NULL)");
  db.exec("INSERT INTO ocean_members VALUES('ws','dev-room','dev')");
  db.exec("INSERT INTO ocean_members VALUES('ws','review-room','review')");
  const task = {
    id: 'task',
    workspaceId: 'ws',
    projectRoot: '/project',
    baseCommit: 'a'.repeat(40),
    worktreeRoot: null,
    ownerRoomId: 'dev-room',
    devBotId: 'dev',
    reviewBotId: 'review',
    reviewRoomId: 'review-room',
    status: 'reserved',
    policyVersion: 1,
    policy: {
      version: 1,
      devCapabilities: ['project_read'],
      reviewCapabilities: ['changeset_read'],
      testPresets: [],
    },
    lease: {
      ownerId: 'profile',
      taskId: 'task',
      requestId: 'start',
      binding: 'original',
      kind: 'coding',
      projectRoot: '/project',
      token: 'original-token',
    },
    createdAt: '2026-11-02T00:00:00.000Z',
  };
  db.prepare('INSERT INTO ocean_coding_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'task',
    'ws',
    '/project',
    'dev-room',
    'dev',
    'review-room',
    'review',
    'reserved',
    1,
    JSON.stringify(task),
  );
  db.exec("INSERT INTO ocean_coding_receipts VALUES('start','original','task')");

  db.exec("INSERT INTO tool_invocations_v1 VALUES('legacy','shell','uncertain')");
  return db;
}
it('migrates frozen schema6 additively without altering its tables or unresolved effects', () => {
  const db = old(),
    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='meta'")
      .all()
      .map((r) => String(r.name));
  const before = tables.map((t) => [t, db.prepare('SELECT * FROM "' + t + '"').all()] as const);
  initializeSchema(db);
  for (const [table, rows] of before)
    expect(db.prepare('SELECT * FROM "' + table + '"').all()).toEqual(rows);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('13');
  for (const name of ['ocean_worktrees', 'ocean_changesets', 'ocean_capture_receipts'])
    expect(db.prepare('SELECT * FROM ' + name).all()).toEqual([]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('rolls back worktree schema on receipt-table failure and can retry', () => {
  const db = old();
  db.exec('CREATE TABLE ocean_capture_receipts(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('6');
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_worktrees'").get(),
  ).toBeUndefined();
  expect(db.prepare('SELECT outcome FROM tool_invocations_v1').get()?.outcome).toBe('uncertain');
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  db.exec('DROP TABLE ocean_capture_receipts');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('13');
});
