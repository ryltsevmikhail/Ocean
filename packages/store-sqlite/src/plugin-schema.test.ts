import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, SCHEMA_VERSION, openDatabase } from './schema.js';
import { PLUGIN_TABLES } from './plugin-schema.js';
import { inspectDatabase } from './maintenance.js';
import { readPluginBackupInventory } from './plugin-backup-inventory.js';
import { SqliteToolJournal } from './tool-journal.js';

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function memory(): DatabaseSync {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return db;
}
function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-plugin-migration-'));
  directories.push(directory);
  return join(directory, 'runtime.sqlite');
}
function open(path: string): DatabaseSync {
  const db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return db;
}
function tables(db: DatabaseSync): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((row) => String(row['name']));
}
function seedConversation(db: DatabaseSync): void {
  // A real profile opens the durable store, which also creates the journal tables.
  new SqliteToolJournal(db);
  db.exec(`
    INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES('bot_dev','ws','dev','Dev','Role','test','test',1);
    INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
    INSERT INTO ocean_members VALUES('ws','room','bot_dev');
    INSERT INTO ocean_messages VALUES('m1','ws','room',1,'user',NULL,'hello','2026-11-04T00:00:00.000Z',NULL,NULL);
  `);
}
function downgradeTo16(path: string): void {
  const db = new DatabaseSync(path);
  try {
    for (const table of PLUGIN_TABLES) db.exec('DROP TABLE IF EXISTS ' + table);
    omitModelConnectionSchema(db);
    db.exec("UPDATE meta SET value='16' WHERE key='schema_version'");
  } finally {
    db.close();
  }
}
function snapshot(path: string): {
  readonly messages: number;
  readonly rooms: number;
  readonly tables: string[];
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      messages: Number(db.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n']),
      rooms: Number(db.prepare('SELECT count(*) AS n FROM ocean_rooms').get()?.['n']),
      tables: tables(db),
    };
  } finally {
    db.close();
  }
}

describe('plugin migration 17', () => {
  it('creates every authoritative plugin table at the current schema version', () => {
    const db = memory();
    expect(SCHEMA_VERSION).toBe(20);
    expect(tables(db)).toEqual(expect.arrayContaining([...PLUGIN_TABLES]));
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(Number(db.prepare('SELECT count(*) AS n FROM ocean_plugin_grants').get()?.['n'])).toBe(
      0,
    );
  });

  it('migrates an existing schema-16 profile with zero inherited grants and intact history', () => {
    const path = file();
    const first = open(path);
    seedConversation(first);
    first.close();
    databases.splice(databases.indexOf(first), 1);
    downgradeTo16(path);
    const before = snapshot(path);
    expect(before.messages).toBe(1);
    expect(inspectDatabase(path).status).toBe('ok');
    expect(readPluginBackupInventory(path).versions).toEqual([]);

    const migrated = open(path);
    expect(tables(migrated)).toEqual(expect.arrayContaining([...PLUGIN_TABLES]));
    expect(
      migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe(String(SCHEMA_VERSION));
    expect(
      Number(migrated.prepare('SELECT count(*) AS n FROM ocean_plugin_grants').get()?.['n']),
    ).toBe(0);
    expect(
      Number(migrated.prepare('SELECT count(*) AS n FROM ocean_plugin_connections').get()?.['n']),
    ).toBe(0);
    expect(
      Number(migrated.prepare('SELECT count(*) AS n FROM ocean_plugin_versions').get()?.['n']),
    ).toBe(0);
    const after = snapshot(path);
    expect(after.messages).toBe(before.messages);
    expect(after.rooms).toBe(before.rooms);
    // Reopening migrates nothing twice and keeps the profile readable.
    migrated.close();
    databases.splice(databases.indexOf(migrated), 1);
    const reopened = open(path);
    expect(
      reopened.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe(String(SCHEMA_VERSION));
  });

  it('rolls a failed migration back and lets the operator reopen after repair', () => {
    const path = file();
    const first = open(path);
    seedConversation(first);
    first.close();
    databases.splice(databases.indexOf(first), 1);
    const tamper = new DatabaseSync(path);
    try {
      for (const table of PLUGIN_TABLES) tamper.exec('DROP TABLE IF EXISTS ' + table);
      omitModelConnectionSchema(tamper);
      tamper.exec("UPDATE meta SET value='16' WHERE key='schema_version'");
      // A view with a plugin table's name makes the migration DDL fail inside its transaction.
      tamper.exec('CREATE VIEW ocean_plugin_grants AS SELECT 1 AS x');
    } finally {
      tamper.close();
    }
    expect(() => open(path)).toThrow();
    const failed = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        failed.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('16');
      expect(failed.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n']).toBe(1);
      expect(
        failed
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ocean_plugin_versions'",
          )
          .get(),
      ).toBeUndefined();
      failed.close();
    } finally {
      if (failed.isOpen) failed.close();
    }
    const repair = new DatabaseSync(path);
    try {
      repair.exec('DROP VIEW ocean_plugin_grants');
    } finally {
      repair.close();
    }
    const reopened = open(path);
    expect(tables(reopened)).toEqual(expect.arrayContaining([...PLUGIN_TABLES]));
    expect(Number(reopened.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n'])).toBe(
      1,
    );
  });
});
