import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, initializeSchema } from './schema.js';
it('upgrades a v10 profile atomically and refuses a damaged v11 decision table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    omitModelConnectionSchema(db);
    db.exec(
      "DROP TABLE ocean_desktop_operations; DROP TABLE ocean_desktop_uploads; DROP TABLE ocean_desktop_adopted; DROP TABLE IF EXISTS ocean_owner_decisions; DROP TABLE ocean_profile_rebinds; DROP TABLE ocean_rebind_observations; DROP TABLE ocean_execution_epoch; DROP TABLE ocean_restore_origins; DROP TABLE ocean_restore_origin; DROP TABLE ocean_retired_epochs; UPDATE meta SET value='10' WHERE key='schema_version'; CREATE TABLE ocean_owner_decisions(collision TEXT)",
    );
    expect(() => initializeSchema(db)).toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '10',
    );
    db.exec('DROP TABLE ocean_owner_decisions');
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    db.exec('DROP TABLE ocean_owner_decisions');
    expect(() => initializeSchema(db)).toThrow('missing table');
  } finally {
    db.close();
  }
});
