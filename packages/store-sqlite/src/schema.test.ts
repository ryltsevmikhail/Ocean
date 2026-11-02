import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  initializeSchema,
  openDatabase,
} from './schema.js';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases) {
    if (db.isOpen) db.close();
  }
  databases.length = 0;
});

function memoryDatabase(): DatabaseSync {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all();
  return rows.map((row) => row['name']).filter((name): name is string => typeof name === 'string');
}

describe('SQLite durability profile', () => {
  it('enables full synchronous, foreign keys and a bounded busy timeout', () => {
    const db = memoryDatabase();

    expect(db.prepare('PRAGMA synchronous').get()?.['synchronous']).toBe(2);
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    expect(db.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  it('accepts a custom busy timeout within the bound', () => {
    const db = openDatabase(':memory:', 2_500);
    databases.push(db);

    expect(db.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(2_500);
  });

  it('rejects a busy timeout outside the bound', () => {
    expect(() => openDatabase(':memory:', -1)).toThrow(RangeError);
    expect(() => openDatabase(':memory:', 60_001)).toThrow(RangeError);
    expect(() => openDatabase(':memory:', 1.5)).toThrow(RangeError);
  });
});

describe('schema initialization', () => {
  it('creates the store tables and records the schema version', () => {
    const db = memoryDatabase();

    expect(tableNames(db).sort()).toEqual([
      'checkpoints',
      'command_receipts',
      'events',
      'meta',
      'ocean_bots',
      'ocean_members',
      'ocean_messages',
      'ocean_receipts',
      'ocean_rooms',
      'ocean_workspace',
    ]);
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it('is idempotent for a database at the supported version', () => {
    const db = memoryDatabase();

    expect(() => {
      initializeSchema(db);
    }).not.toThrow();
  });

  it('fails closed on a newer schema version', () => {
    const db = memoryDatabase();
    db.prepare(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`).run();

    expect(() => {
      initializeSchema(db);
    }).toThrow(/newer than the supported version/);
  });

  it('fails closed on an older schema version', () => {
    const db = memoryDatabase();
    db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();

    expect(() => {
      initializeSchema(db);
    }).toThrow(/older than the supported version/);
  });

  it('fails closed on a database with tables but no schema version', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    db.exec('CREATE TABLE legacy (id TEXT PRIMARY KEY)');

    expect(() => {
      initializeSchema(db);
    }).toThrow(/not a RunneTS store/);
  });

  it('fails closed when the meta table has no schema version row', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

    expect(() => {
      initializeSchema(db);
    }).toThrow(/no schema_version row/);
  });

  it('fails closed when a table of the supported schema is missing', () => {
    const db = memoryDatabase();
    db.exec('DROP TABLE checkpoints');

    expect(() => {
      initializeSchema(db);
    }).toThrow(/missing table checkpoints/);
  });
});
