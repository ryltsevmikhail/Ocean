import { omitRoomTaskSchema } from '../test-fixtures/room-task-v26.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
import { serviceConnection, ownerGrant } from '../../../test-fixtures/service-authority.js';
const receipt = {
  requestId: 'prepared',
  ownerId: 'owner',
  binding: 'a'.repeat(64),
  method: 'service.connection-set',
  state: 'prepared' as const,
  secretReference: 'psec_fixture123',
  expectedVersions: null,
  result: null,
};
it('schema25 gains only one bounded empty table; publication failure rolls it back with legacy authority intact', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    const store = new SqliteServiceAuthority(db);
    store.atomic((tx) => {
      tx.putConnection(serviceConnection, null);
      tx.putGrant(ownerGrant, null);
    });
    const before = db.prepare('SELECT * FROM ocean_service_connections').all();
    const grants = db.prepare('SELECT * FROM ocean_owner_scope_grants').all();
    omitRoomTaskSchema(db);
    db.exec(
      "DROP TABLE ocean_service_owner_receipts; UPDATE meta SET value='25' WHERE key='schema_version'; CREATE TRIGGER fail_26 BEFORE UPDATE ON meta WHEN NEW.value='27' BEGIN SELECT RAISE(ABORT,'receipt migration interrupted'); END",
    );
    expect(() => initializeSchema(db)).toThrow('receipt migration interrupted');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_service_owner_receipts'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM ocean_service_connections').all()).toEqual(before);
    db.exec('DROP TRIGGER fail_26');
    initializeSchema(db);
    expect(db.prepare('SELECT * FROM ocean_service_owner_receipts').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM ocean_service_connections').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM ocean_owner_scope_grants').all()).toEqual(grants);
    expect(() =>
      db
        .prepare('INSERT INTO ocean_service_owner_receipts VALUES(?,?,?,?)')
        .run('large', 'owner', 'prepared', JSON.stringify({ value: 'x'.repeat(131072) })),
    ).toThrow();
    db.exec('DROP TABLE ocean_service_owner_receipts');
    expect(() => initializeSchema(db)).toThrow('missing table ocean_service_owner_receipts');
  } finally {
    db.close();
  }
});
it('prepared/completed receipts survive a real close/reopen and copied snapshot without private material or automatic submission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-service-receipt-'));
  const path = join(dir, 'db'),
    copy = join(dir, 'copied');
  let db = new DatabaseSync(path);
  try {
    initializeSchema(db);
    new SqliteServiceAuthority(db).atomic((tx) => {
      tx.putOwnerReceipt(receipt, null);
      tx.putConnection(serviceConnection, null);
      tx.putOwnerReceipt(
        { ...receipt, requestId: 'done', state: 'completed', result: serviceConnection },
        null,
      );
    });
    db.close();
    copyFileSync(path, copy);
    db = new DatabaseSync(copy);
    initializeSchema(db);
    const store = new SqliteServiceAuthority(db);
    expect(store.atomic((tx) => tx.ownerReceipt('prepared'))).toEqual(receipt);
    expect(store.atomic((tx) => tx.ownerReceipt('done'))).toMatchObject({
      state: 'completed',
      result: serviceConnection,
    });
    expect(
      store.atomic((tx) => tx.putOwnerReceipt({ ...receipt, binding: 'b'.repeat(64) }, null)),
    ).toBe(false);
    expect(store.atomic((tx) => tx.listGrants())).toEqual([]);
    expect(store.atomic((tx) => tx.connection('third'))).toEqual(serviceConnection);
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
