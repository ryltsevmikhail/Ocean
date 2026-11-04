import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { unconfiguredModelConnection } from '@runnets/application';
import { initializeSchema, SCHEMA_VERSION } from './schema.js';
import { SqliteModelConnections } from './model-connection-storage.js';
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
it('migrates missing envelopes to null while preserving every frozen receipt byte', () => {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  const { pendingRequest: _missing, ...old } = unconfiguredModelConnection('fixture');
  db.prepare('INSERT INTO ocean_model_connections VALUES(?,?)').run(
    old.connectionId,
    JSON.stringify(old),
  );
  const receipt = '{ "version": 1, "historic": "untouched" }';
  db.prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)').run(
    'old',
    old.connectionId,
    'binding',
    receipt,
  );
  db.exec("UPDATE meta SET value='22' WHERE key='schema_version'");
  initializeSchema(db);
  expect(SCHEMA_VERSION).toBe(23);
  expect(
    JSON.parse(
      db
        .prepare('SELECT payload FROM ocean_model_connections WHERE connection_id=?')
        .get(old.connectionId)!['payload'] as string,
    ),
  ).toHaveProperty('pendingRequest', null);
  expect(db.prepare('SELECT result FROM ocean_model_connection_receipts').get()?.['result']).toBe(
    receipt,
  );
  expect(new SqliteModelConnections(db).read(old.connectionId)?.pendingRequest).toBeNull();
});
it('refuses an unknown envelope version and rolls back migration publication', () => {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  const row = { ...unconfiguredModelConnection('fixture'), pendingRequest: { version: 2 } };
  db.prepare('INSERT INTO ocean_model_connections VALUES(?,?)').run(
    row.connectionId,
    JSON.stringify(row),
  );
  db.exec("UPDATE meta SET value='22' WHERE key='schema_version'");
  expect(() => initializeSchema(db)).toThrow('connection_unverified');
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '22',
  );
});
