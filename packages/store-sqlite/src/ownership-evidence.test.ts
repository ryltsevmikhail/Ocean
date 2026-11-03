import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { acquireOwnership } from './ownership.js';
import { ownerBusy } from './maintenance-owner.js';
import { initializeSchema } from './schema.js';

it.each(['legacy', 'foreign-boot', 'foreign-namespace', 'malformed-uuid', 'changed-owner'])(
  'holds %s evidence despite a locally absent PID',
  (mode) => {
    const db = new DatabaseSync(':memory:');
    try {
      initializeSchema(db);
      acquireOwnership(db, { id: randomUUID(), pid: 3400001 }, () => false);
      const previous = String(db.prepare('SELECT owner FROM runtime_owner_v1').get()?.['owner']);
      const parts = previous.split(':');
      if (mode === 'foreign-boot') parts[1] = randomUUID();
      if (mode === 'foreign-namespace') parts[3] = '1';
      if (mode === 'malformed-uuid') parts[4] = 'unverified';
      const owner =
        mode.startsWith('foreign-') || mode === 'malformed-uuid' ? parts.join(':') : mode;
      db.prepare('UPDATE runtime_owner_v1 SET owner=?').run(owner);
      expect(() => acquireOwnership(db, { id: randomUUID(), pid: 3400002 }, () => false)).toThrow(
        'owned',
      );
      expect(ownerBusy(db)).toBe(true);
      db.exec(
        "DROP TABLE ocean_owner_decisions; UPDATE meta SET value='10' WHERE key='schema_version'",
      );
      expect(() => initializeSchema(db)).toThrow('Schema migration refused');
      expect(db.prepare('SELECT owner FROM runtime_owner_v1').get()?.['owner']).toBe(owner);
    } finally {
      db.close();
    }
  },
);
