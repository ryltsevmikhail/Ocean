import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
it('upgrades a v10 profile atomically and refuses a damaged v11 decision table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    db.exec(
      "DROP TABLE IF EXISTS ocean_owner_decisions; UPDATE meta SET value='10' WHERE key='schema_version'; CREATE TABLE ocean_owner_decisions(collision TEXT)",
    );
    expect(() => initializeSchema(db)).toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '10',
    );
    db.exec('DROP TABLE ocean_owner_decisions');
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '11',
    );
    db.exec('DROP TABLE ocean_owner_decisions');
    expect(() => initializeSchema(db)).toThrow('missing table');
  } finally {
    db.close();
  }
});
