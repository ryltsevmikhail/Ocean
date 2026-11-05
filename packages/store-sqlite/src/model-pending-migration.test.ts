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
  expect(SCHEMA_VERSION).toBe(24);
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
it.each([22, 23])(
  'refuses schema%s without its required policy table before mutating version, rows or receipts',
  (version) => {
    const db = new DatabaseSync(':memory:');
    opened.push(db);
    initializeSchema(db);
    const { pendingRequest: _missing, ...old } = unconfiguredModelConnection('fixture');
    const payload = ' ' + JSON.stringify(old) + '\n';
    db.prepare('INSERT INTO ocean_model_connections VALUES(?,?)').run(old.connectionId, payload);
    const receipt = '{ "version": 1, "historic": "byte-preserved" }\n';
    db.prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)').run(
      'old',
      old.connectionId,
      'binding',
      receipt,
    );
    db.exec('DROP TABLE ocean_room_model_policies');
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
    const snapshot = () => ({
      meta: db.prepare('SELECT * FROM meta ORDER BY key').all(),
      connections: db.prepare('SELECT * FROM ocean_model_connections ORDER BY connection_id').all(),
      receipts: db
        .prepare('SELECT * FROM ocean_model_connection_receipts ORDER BY request_id')
        .all(),
    });
    const before = snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => initializeSchema(db)).toThrow(
        'database schema is missing table ocean_room_model_policies',
      );
      expect(snapshot()).toEqual(before);
      expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
        String(version),
      );
      expect(
        db
          .prepare('SELECT payload FROM ocean_model_connections WHERE connection_id=?')
          .get(old.connectionId)?.['payload'],
      ).toBe(payload);
      expect(
        db
          .prepare('SELECT result FROM ocean_model_connection_receipts WHERE request_id=?')
          .get('old')?.['result'],
      ).toBe(receipt);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_room_model_policies'").get(),
      ).toBeUndefined();
    }
  },
);
