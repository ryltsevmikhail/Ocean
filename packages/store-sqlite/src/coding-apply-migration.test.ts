import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeSchema } from './schema.js';

it('migrates schema 9 application receipts atomically and refuses a missing current table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    db.exec(
      "DROP TABLE ocean_desktop_operations; DROP TABLE ocean_desktop_uploads; DROP TABLE ocean_desktop_adopted; DROP TABLE ocean_owner_decisions; DROP TABLE ocean_coding_applications; UPDATE meta SET value='9' WHERE key='schema_version'",
    );
    db.exec('CREATE TABLE ocean_coding_applications(collision TEXT)');
    expect(() => initializeSchema(db)).toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '9',
    );
    db.exec('DROP TABLE ocean_coding_applications');
    initializeSchema(db);
    expect(db.prepare('SELECT * FROM ocean_coding_applications').all()).toEqual([]);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '12',
    );
    db.exec('DROP TABLE ocean_coding_applications');
    expect(() => initializeSchema(db)).toThrow('missing table ocean_coding_applications');
  } finally {
    db.close();
  }
});
