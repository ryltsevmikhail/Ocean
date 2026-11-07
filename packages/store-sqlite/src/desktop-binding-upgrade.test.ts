import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
import { acquireOwnership } from './ownership.js';
import { upgradeDesktopBinding } from './desktop-binding-upgrade.js';
const databases: DatabaseSync[] = [];
const binding = {
  profileId: 'a'.repeat(64),
  root: '/synthetic/tree',
  identity: '1:2:3:4:16832:5',
  originalRoot: '/synthetic/original',
};
function fixture(owned = true) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  if (owned)
    acquireOwnership(
      db,
      { id: '12345678-1234-4123-8123-123456789abc', pid: process.pid },
      () => false,
    );
  db.prepare("INSERT INTO meta VALUES('desktop_assets_binding',?)").run(JSON.stringify(binding));
  return db;
}
const saved = (db: DatabaseSync) =>
  db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.['value'];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('requires exclusive ownership before requesting filesystem proof', () => {
  const db = fixture(false);
  let calls = 0;
  expect(() =>
    upgradeDesktopBinding(db, () => {
      calls++;
      return null;
    }),
  ).toThrow();
  expect(calls).toBe(0);
  expect(saved(db)).toBe(JSON.stringify(binding));
});
it('rolls back a stale serialized binding CAS and closes its held root', () => {
  const db = fixture();
  let closed = false;
  expect(() =>
    upgradeDesktopBinding(db, () => {
      db.prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding'").run(
        JSON.stringify({ ...binding, identity: 'changed' }),
      );
      return {
        binding: { ...binding, identity: 'new' },
        verify() {},
        close() {
          closed = true;
        },
      };
    }),
  ).toThrow('desktop_binding_conflict');
  expect(saved(db)).toBe(JSON.stringify(binding));
  expect(closed).toBe(true);
});
it.each([1, 2])('rolls back when root validation fails at commit checkpoint %s', (checkpoint) => {
  const db = fixture();
  let calls = 0,
    closed = false;
  expect(() =>
    upgradeDesktopBinding(db, () => ({
      binding: { ...binding, identity: 'new' },
      verify() {
        if (++calls === checkpoint) throw Error('changed root');
      },
      close() {
        closed = true;
      },
    })),
  ).toThrow('changed root');
  expect(saved(db)).toBe(JSON.stringify(binding));
  expect(closed).toBe(true);
});
it('keeps legacy active ready lineage exact without preparing a meta-only upgrade', () => {
  const db = fixture();
  db.prepare("INSERT INTO ocean_profile_rebinds VALUES('old-ready',1,'ready',?)").run(
    JSON.stringify({ result: { desktop: binding } }),
  );
  db.exec("INSERT INTO ocean_execution_epoch VALUES(1,'old-ready')");
  const ready = db.prepare('SELECT * FROM ocean_profile_rebinds').all();
  let prepared = false;
  expect(
    upgradeDesktopBinding(db, () => {
      prepared = true;
      return null;
    }),
  ).toBe('legacy-ready');
  expect(prepared).toBe(false);
  expect(saved(db)).toBe(JSON.stringify(binding));
  expect(db.prepare('SELECT * FROM ocean_profile_rebinds').all()).toEqual(ready);
});
it('bounds the serialized binding before parsing or requesting filesystem proof', () => {
  const db = fixture();
  const oversized = JSON.stringify({ ...binding, originalRoot: '/' + 'x'.repeat(16384) });
  db.prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding'").run(oversized);
  let requested = false;
  expect(() =>
    upgradeDesktopBinding(db, () => {
      requested = true;
      return null;
    }),
  ).toThrow('desktop_inventory_limit');
  expect(requested).toBe(false);
  expect(saved(db)).toBe(oversized);
});
