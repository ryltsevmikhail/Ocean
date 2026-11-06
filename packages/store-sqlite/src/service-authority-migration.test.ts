import { omitRoomTaskSchema } from '../test-fixtures/room-task-v26.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDatabase } from './maintenance.js';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../test-fixtures/plugin-operation-rig.js';
import { SERVICE_AUTHORITY_TABLES } from './service-authority-schema.js';
import { initializeSchema, SCHEMA_VERSION } from './schema.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import { serviceCatalog, serviceConnection } from '../../../test-fixtures/service-authority.js';
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
});
function tables(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => String(r['name']));
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries(
    tables(db)
      .filter(
        (t) =>
          t !== 'meta' &&
          !SERVICE_AUTHORITY_TABLES.some((n) => n === t) &&
          t !== 'ocean_service_owner_receipts' &&
          t !== 'ocean_room_tasks' &&
          t !== 'ocean_room_deliveries',
      )
      .map((t) => [t, db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()]),
  );
}
function schema23(db: DatabaseSync) {
  omitRoomTaskSchema(db);
  db.exec(
    "DROP TABLE ocean_service_owner_receipts; DROP TABLE ocean_owner_scope_grants; DROP TABLE ocean_service_connections; DROP TABLE ocean_service_catalogs; UPDATE meta SET value='23' WHERE key='schema_version'",
  );
}

describe('service authority migration 24', () => {
  it('adds exactly three empty tables to schema23 preserving all legacy rows and unresolved holds', async () => {
    const f = fixture(() => ({
      kind: 'uncertain',
      invocationId: 'lost',
      code: 'transport_failure',
      detail: 'lost response',
    }));
    await f.call('lost');
    f.db
      .exec(`INSERT INTO ocean_plugin_consents VALUES('historic',1,'https://old.example','before',NULL);
      INSERT INTO ocean_plugin_confirmations VALUES('pending','conn_work',1,'pending','before',NULL);
      INSERT INTO ocean_coding_approvals VALUES('old-approval','{ "historic": "approval bytes" }');
      INSERT INTO ocean_coding_approval_claims VALUES('old-key','old-approval');
      INSERT INTO tool_invocations_v1 VALUES('legacy','unknown','uncertain');`);
    schema23(f.db);
    const before = snapshot(f.db),
      oldTables = tables(f.db),
      pending = f.journal.inspectPending();
    initializeSchema(f.db);
    expect(SCHEMA_VERSION).toBe(28);
    expect(f.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '28',
    );
    expect(
      tables(f.db)
        .filter((n) => !oldTables.includes(n))
        .sort(),
    ).toEqual(
      [
        ...SERVICE_AUTHORITY_TABLES,
        'ocean_service_owner_receipts',
        'ocean_room_tasks',
        'ocean_room_deliveries',
      ].sort(),
    );
    for (const table of SERVICE_AUTHORITY_TABLES)
      expect(f.db.prepare('SELECT * FROM ' + table).all()).toEqual([]);
    expect(snapshot(f.db)).toEqual(before);
    expect(new SqliteToolJournal(f.db).inspectPending()).toEqual(pending);
    expect(
      f.journal.claimNow('new', 'unrelated', { taskRunId: 'another', attemptId: 'another' }, 'new'),
    ).toBe(false);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    initializeSchema(f.db);
    expect(snapshot(f.db)).toEqual(before);
  });
  it('rolls every new table back when migration publication fails', () => {
    const db = new DatabaseSync(':memory:');
    opened.push(db);
    initializeSchema(db);
    schema23(db);
    db.exec(
      "CREATE TRIGGER stop_authority BEFORE UPDATE ON meta WHEN NEW.value='28' BEGIN SELECT RAISE(ABORT,'publication failed'); END",
    );
    expect(() => initializeSchema(db)).toThrow('publication failed');
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '23',
    );
    expect(tables(db).some((t) => SERVICE_AUTHORITY_TABLES.some((n) => n === t))).toBe(false);
  });
  it('refuses a newer database and missing schema24 tables without mutation', () => {
    const db = new DatabaseSync(':memory:');
    opened.push(db);
    initializeSchema(db);
    omitRoomTaskSchema(db);
    db.exec("UPDATE meta SET value='29' WHERE key='schema_version'");
    expect(() => initializeSchema(db)).toThrow(/newer/);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '29',
    );
    omitRoomTaskSchema(db);
    db.exec(
      "UPDATE meta SET value='24' WHERE key='schema_version'; DROP TABLE ocean_owner_scope_grants",
    );
    expect(() => initializeSchema(db)).toThrow('missing table ocean_owner_scope_grants');
  });
  it('enforces same-database catalog foreign keys and rolls back invalid publication', () => {
    const db = new DatabaseSync(':memory:');
    opened.push(db);
    initializeSchema(db);
    const s = new SqliteServiceAuthority(db);
    expect(() => s.atomic((tx) => tx.putCatalog(serviceCatalog))).toThrow(/FOREIGN KEY/);
    s.atomic((tx) => {
      tx.putConnection(serviceConnection, null);
      tx.putConnection({ ...serviceConnection, id: 'other' }, null);
      tx.putCatalog(serviceCatalog);
    });
    expect(() =>
      db
        .prepare('UPDATE ocean_service_connections SET current_catalog_id=? WHERE id=?')
        .run('catalog', 'other'),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(s.atomic((tx) => tx.connection('other')?.currentCatalogId)).toBeNull();
  });
});

it('keeps schema23 inspectable after the current schema becomes24', () => {
  const dir = mkdtempSync(join(tmpdir(), 'authority23-'));
  try {
    const path = join(dir, 'db');
    const db = new DatabaseSync(path);
    initializeSchema(db);
    new SqliteToolJournal(db);
    schema23(db);
    db.close();
    expect(inspectDatabase(path)).toMatchObject({ status: 'ok', summary: { schema: 23 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
