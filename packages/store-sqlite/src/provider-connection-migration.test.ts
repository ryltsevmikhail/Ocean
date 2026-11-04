import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  initializeSchema,
  openDatabase,
} from './schema.js';
import { SqliteProviderConnections } from './provider-connection-storage.js';
import { PROVIDER_CONNECTION_TABLES } from './provider-connection-schema.js';

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
const row = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  secretRef: 'psec_0123456789abcdef0123456789abcdef',
  intent: 'active' as const,
  revision: 1,
  requestId: 'set-1',
  binding: 'digest',
  lastCheck: {
    outcome: 'ok' as const,
    httpStatus: 200,
    durationMs: 12,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelSupported: true,
    source: 'saved' as const,
    revision: 1,
    checkedAt: '2026-11-04T00:00:00.000Z',
  },
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const status = {
  provider: 'deepseek',
  source: 'saved' as const,
  state: 'connected' as const,
  model: 'deepseek-flash',
  models: ['deepseek-flash'],
  modelCapabilities: [{ model: 'deepseek-flash', imageInput: true }],
  revision: 1,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: null,
};

describe('provider connection migration 15', () => {
  it('creates the metadata and receipt tables at the current schema version', () => {
    const db = memory();
    expect(SCHEMA_VERSION).toBe(21);
    expect(tables(db)).toEqual(expect.arrayContaining([...PROVIDER_CONNECTION_TABLES]));
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
  });

  it('migrates an existing schema-14 database and preserves earlier rows', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    connections.put(row, null);
    // Recreate the accepted schema-14 shape: no provider tables, older version marker.
    omitModelConnectionSchema(db);
    db.exec(`DROP TABLE ocean_provider_receipts; DROP TABLE ocean_provider_connections;
      UPDATE meta SET value='14' WHERE key='schema_version';
      INSERT INTO meta (key, value) VALUES ('legacy-marker', 'kept');`);
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(db.prepare("SELECT value FROM meta WHERE key='legacy-marker'").get()?.['value']).toBe(
      'kept',
    );
    expect(tables(db)).toEqual(expect.arrayContaining([...PROVIDER_CONNECTION_TABLES]));
    expect(connections.read('deepseek')).toBeNull();
  });

  it('opens an older shipped fixture and migrates it forward', () => {
    const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    databases.push(db);
    db.exec(readFileSync(new URL('./fixtures/ocean-schema-v6.sql', import.meta.url), 'utf8'));
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(tables(db)).toEqual(expect.arrayContaining([...PROVIDER_CONNECTION_TABLES]));
  });

  it('refuses a database newer than the supported schema', () => {
    const db = memory();
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(
      String(SCHEMA_VERSION + 1),
    );
    expect(() => initializeSchema(db)).toThrow(/newer than the supported version/);
  });
});

describe('SQLite provider connection metadata', () => {
  it('round-trips metadata and bounded check information without credential bytes', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    expect(connections.read('deepseek')).toBeNull();
    connections.put(row, null);
    const read = connections.read('deepseek');
    expect(read).toEqual(row);
    const stored = JSON.stringify(db.prepare('SELECT * FROM ocean_model_connections').all());
    expect(stored).not.toContain('sk-');
    expect(read?.secretRef).toBe(row.secretRef);
  });

  it('guards writes with the owner-visible revision', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    connections.put(row, null);
    expect(() => connections.put({ ...row, revision: 2 }, 0)).toThrow('revision_conflict');
    expect(() => connections.put({ ...row, revision: 2, intent: 'disconnected' }, 1)).not.toThrow();
    expect(connections.read('deepseek')).toMatchObject({ revision: 2, intent: 'disconnected' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM ocean_model_connections').get()?.['n']).toBe(1);
  });

  it('keeps a cancelled check outcome instead of dropping or rewriting it as timeout', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    connections.put({ ...row, lastCheck: { ...row.lastCheck!, outcome: 'cancelled' } }, null);
    expect(connections.read('deepseek')?.lastCheck?.outcome).toBe('cancelled');
  });

  it('persists the activated record and its idempotency receipt atomically', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    connections.put({ ...row, intent: 'pending', secretRef: 'psec_pending' }, null);
    connections.activate({ ...row, revision: 2 }, 1, {
      requestId: 'set-2',
      value: { binding: 'binding-2', result: { ...status, revision: 2 } },
    });
    expect(connections.read('deepseek')).toMatchObject({ revision: 2, intent: 'active' });
    expect(connections.receipt('set-2')).toEqual({
      binding: 'binding-2',
      result: { ...status, revision: 2 },
    });
    expect(connections.receipt('unknown')).toBeNull();
  });

  it('couples a failed receipt insert to the record write', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    connections.activate(row, null, {
      requestId: 'set-1',
      value: { binding: 'binding-1', result: status },
    });
    expect(() =>
      connections.activate({ ...row, revision: 2 }, 1, {
        requestId: 'set-1',
        value: { binding: 'binding-2', result: status },
      }),
    ).toThrow('request_conflict');
    expect(connections.read('deepseek')).toMatchObject({ revision: 1 });
  });

  it('fails closed on a malformed stored receipt instead of replaying garbage', () => {
    const db = memory();
    const connections = new SqliteProviderConnections(db);
    db.prepare(
      'INSERT INTO ocean_provider_receipts (request_id, provider, binding, result) VALUES (?,?,?,?)',
    ).run('bad', 'deepseek', 'binding', 'not-json');
    expect(() => connections.receipt('bad')).toThrow('provider_unverified');
  });
});
