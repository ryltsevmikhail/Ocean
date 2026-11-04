/**
 * Migration 18 qualification: the durable plugin operation table is additive,
 * preserves existing profiles, and a failed migration rolls back cleanly.
 */
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as RawDatabase } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, SCHEMA_VERSION, openDatabase } from './schema.js';
import { PLUGIN_OPERATION_TABLES } from './plugin-operation-schema.js';
import { SqliteToolJournal } from './tool-journal.js';

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('plugin operation migration 18', () => {
  it('creates the operations table and migrates a genuine schema-17 profile with zero operations', () => {
    expect(SCHEMA_VERSION).toBe(19);
    const directory = mkdtempSync(join(tmpdir(), 'ocean-op-migration-'));
    directories.push(directory);
    const path = join(directory, 'runtime.sqlite');
    const first = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
    new SqliteToolJournal(first);
    first.exec(`
      INSERT INTO ocean_workspace VALUES(1,'ws','/project');
      INSERT INTO ocean_bots VALUES('bot_dev','ws','dev','Dev','Role','test','test',1);
      INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
      INSERT INTO ocean_members VALUES('ws','room','bot_dev');
      INSERT INTO ocean_messages VALUES('m1','ws','room',1,'user',NULL,'hello','2026-11-04T00:00:00.000Z',NULL,NULL);
    `);
    first.close();
    // Genuine previous-release shape: no operations table, schema version 17.
    const raw = new RawDatabase(path);
    try {
      for (const table of PLUGIN_OPERATION_TABLES) raw.exec('DROP TABLE IF EXISTS ' + table);
      raw.exec("UPDATE meta SET value='17' WHERE key='schema_version'");
    } finally {
      raw.close();
    }
    const migrated = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
    databases.push(migrated);
    expect(
      migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe('19');
    const tables = migrated
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((row) => String(row['name']));
    expect(tables).toEqual(expect.arrayContaining([...PLUGIN_OPERATION_TABLES]));
    expect(
      Number(migrated.prepare('SELECT count(*) AS n FROM ocean_plugin_operations').get()?.['n']),
    ).toBe(0);
    expect(Number(migrated.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n'])).toBe(
      1,
    );
    expect(Number(migrated.prepare('SELECT count(*) AS n FROM ocean_rooms').get()?.['n'])).toBe(1);
  });

  it('rolls a failed operations migration back to schema 17', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ocean-op-rollback-'));
    directories.push(directory);
    const path = join(directory, 'runtime.sqlite');
    const first = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
    new SqliteToolJournal(first);
    first.exec(`INSERT INTO ocean_workspace VALUES(1,'ws','/project')`);
    first.close();
    const raw = new RawDatabase(path);
    try {
      for (const table of PLUGIN_OPERATION_TABLES) raw.exec('DROP TABLE IF EXISTS ' + table);
      // Conflicting object makes the create fail after the version bump intent.
      raw.exec('CREATE VIEW ocean_plugin_operations AS SELECT 1 AS id');
      raw.exec("UPDATE meta SET value='17' WHERE key='schema_version'");
    } finally {
      raw.close();
    }
    expect(() => openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS)).toThrow();
    const check = new RawDatabase(path, { readOnly: true });
    try {
      expect(
        check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('17');
      expect(
        check.prepare(`SELECT name FROM sqlite_master WHERE name='ocean_plugin_operations'`).get(),
      ).toBeDefined();
      expect(Number(check.prepare('SELECT count(*) AS n FROM ocean_workspace').get()?.['n'])).toBe(
        1,
      );
    } finally {
      check.close();
    }
  });
});
