import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
const opened: DatabaseSync[] = [];
function previous() {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  omitModelConnectionSchema(db);
  db.exec("UPDATE meta SET value='18' WHERE key='schema_version'");
  db.prepare("INSERT INTO meta VALUES('desktop_assets_binding',?)").run(
    '{"identity":"1:2:3:4:16832:5","root":"/absent/legacy"}',
  );
  db.prepare(
    "INSERT INTO ocean_desktop_operations VALUES('enrollment','legacy-user-data','completed',?)",
  ).run('{"identity":"1:2:3:4:16832:5"}');
  db.prepare(
    "INSERT INTO ocean_desktop_operations VALUES('prepare:room:request','input','started',NULL)",
  ).run();
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
it('advances the capability epoch transactionally without following legacy paths or rewriting history', () => {
  const db = previous();
  const before = db.prepare('SELECT * FROM ocean_desktop_operations ORDER BY id').all();
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '26',
  );
  expect(db.prepare('SELECT * FROM ocean_desktop_operations ORDER BY id').all()).toEqual(before);
  expect(
    db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.['value'],
  ).toBe('{"identity":"1:2:3:4:16832:5","root":"/absent/legacy"}');
  initializeSchema(db);
  expect(db.prepare('SELECT * FROM ocean_desktop_operations ORDER BY id').all()).toEqual(before);
});
it('leaves schema 18 and authority unchanged when capability publication fails', () => {
  const db = previous();
  const before = db.prepare('SELECT * FROM meta ORDER BY key').all();
  db.exec(
    "CREATE TRIGGER stop_capability BEFORE UPDATE ON meta WHEN NEW.key='schema_version' AND NEW.value='26' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END",
  );
  expect(() => initializeSchema(db)).toThrow('synthetic interruption');
  expect(db.prepare('SELECT * FROM meta ORDER BY key').all()).toEqual(before);
});
