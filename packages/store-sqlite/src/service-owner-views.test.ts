import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceOwnerSettings, type ServiceAuthorityStorePort } from '@runnets/application';
import {
  serviceConnection,
  serviceCatalog,
  ownerGrant,
} from '../../../test-fixtures/service-authority.js';
import { initializeSchema } from './schema.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  const store = new SqliteServiceAuthority(db),
    effect = vi.fn(() => {
      throw Error('unused');
    });
  const options = {
    store,
    ownerId: 'owner',
    now: Date.now,
    nextId: () => 'fixture123',
    sha256: (v: string) => createHash('sha256').update(v).digest('hex'),
    writable: () => true,
    secrets: { read: effect, write: effect, replace: effect, remove: effect },
    refresh: async () => effect(),
  };
  return { db, store, options, effect, settings: new ServiceOwnerSettings(options) };
}
const receipt = {
  requestId: 'b',
  ownerId: 'owner',
  binding: 'a'.repeat(64),
  method: 'service.connection-set',
  state: 'prepared' as const,
  secretReference: 'psec_private123',
  expectedVersions: null,
  result: null,
};
it('filters owner/state and stable cursor in SQL before expanding bounded receipts; legacy intent stays explicitly unknown', () => {
  const f = fixture();
  f.store.atomic((tx) => {
    tx.putOwnerReceipt({ ...receipt, requestId: 'a', ownerId: 'foreign' }, null);
    tx.putOwnerReceipt(receipt, null);
    tx.putOwnerReceipt(
      { ...receipt, requestId: 'c', state: 'completed', result: serviceConnection },
      null,
    );
    tx.putOwnerReceipt({ ...receipt, requestId: 'd' }, null);
  });
  // Invalid foreign/late records prove SQL applies filters/limit before validation expansion.
  f.db
    .prepare('INSERT INTO ocean_service_owner_receipts VALUES(?,?,?,?)')
    .run('0', 'foreign', 'prepared', '{}');
  f.db
    .prepare('INSERT INTO ocean_service_owner_receipts VALUES(?,?,?,?)')
    .run('z', 'owner', 'prepared', '{}');
  expect(f.settings.operations({ limit: 1 })).toEqual({
    items: [
      {
        requestId: 'b',
        method: receipt.method,
        state: 'prepared',
        recovery: 'explicit_recovery_required',
        targetId: null,
        operation: null,
      },
    ],
    next: 'b',
  });
  expect(f.settings.operations({ state: 'completed', limit: 1 })).toMatchObject({
    items: [{ requestId: 'c', targetId: 'third', operation: null }],
    next: null,
  });
  expect(f.settings.operations({ after: 'b', limit: 1 })).toMatchObject({
    items: [{ requestId: 'c' }],
    next: 'c',
  });
  expect(f.effect).not.toHaveBeenCalled();
});
it('bounds metadata SQL before parsing; no-argument core enumeration stays complete', () => {
  const f = fixture();
  f.store.atomic((tx) => {
    tx.putConnection(serviceConnection, null);
    tx.putGrant(ownerGrant, null);
  });
  f.db
    .prepare('INSERT INTO ocean_service_connections VALUES(?,?,?,?,?,?)')
    .run('z', 1, 1, 1, null, '{"trust":{"ownerId":"foreign"}}');
  f.db
    .prepare('INSERT INTO ocean_owner_scope_grants VALUES(?,?,?)')
    .run('z', 1, '{"owner":{"ownerId":"foreign"}}');
  expect(f.settings.connections()).toHaveLength(1);
  expect(f.settings.grants()).toHaveLength(1);
  f.db
    .prepare("UPDATE ocean_service_connections SET record=? WHERE id='z'")
    .run('{"trust":{"ownerId":"owner"}}');
  f.db
    .prepare("UPDATE ocean_owner_scope_grants SET record=? WHERE id='z'")
    .run('{"owner":{"ownerId":"owner"}}');
  expect(f.store.atomic((tx) => tx.listConnections({ ownerId: 'owner', limit: 1 }))).toHaveLength(
    1,
  );
  expect(f.store.atomic((tx) => tx.listGrants({ ownerId: 'owner', limit: 1 }))).toHaveLength(1);
  expect(() => f.store.atomic((tx) => tx.listConnections())).toThrow(
    'invalid service connection storage',
  );
  expect(() => f.store.atomic((tx) => tx.listGrants())).toThrow('invalid owner grant storage');
});
it('stops further catalog expansion at the character bound and reports live readiness without effects', () => {
  const f = fixture();
  const names = Array.from({ length: 256 }, (_, n) => String(n).padStart(128, 'x'));
  const tools = names.map((name) => ({ ...serviceCatalog.tools[0]!, name }));
  f.store.atomic((tx) => {
    for (let n = 0; n < 20; n++) {
      const id = String(n).padStart(2, '0'),
        catalogId = 'catalog' + id;
      tx.putConnection({ ...serviceConnection, id }, null);
      tx.putCatalog({ ...serviceCatalog, id: catalogId, connectionId: id, tools });
      tx.publishCatalog(id, serviceConnection, catalogId);
    }
  });
  let catalogs = 0;
  const bounded: ServiceAuthorityStorePort = {
    atomic: (work) =>
      f.store.atomic((tx) =>
        work({
          ...tx,
          catalog: (id) => {
            catalogs++;
            return tx.catalog(id);
          },
        }),
      ),
  };
  const ready = vi.fn(() => false),
    settings = new ServiceOwnerSettings({ ...f.options, store: bounded, ready });
  const rows = settings.connections();
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(20);
  expect(catalogs).toBe(rows.length + 1);
  expect(rows.every((c) => c.readiness === 'unavailable')).toBe(true);
  expect(f.effect).not.toHaveBeenCalled();
});
it('persists exact refresh intent before discovery, validates stored public metadata and leaves old prepared receipts inert', async () => {
  const f = fixture();
  f.store.atomic((tx) => tx.putConnection(serviceConnection, null));
  const input = {
    requestId: 'refresh',
    connectionId: serviceConnection.id,
    expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
  };
  await expect(f.settings.refreshConnection(input)).rejects.toThrow('unused');
  const restarted = new ServiceOwnerSettings(f.options);
  expect(restarted.operations({})).toMatchObject({
    items: [
      {
        targetId: 'third',
        operation: { method: 'service.connection-refresh', input, requiresKey: false },
      },
    ],
  });
  await expect(restarted.refreshConnection(input)).resolves.toMatchObject({ state: 'prepared' });
  expect(f.effect).toHaveBeenCalledTimes(1);
  const r = f.store.atomic((tx) => tx.ownerReceipt('refresh'))!;
  expect(() =>
    f.store.atomic((tx) =>
      tx.putOwnerReceipt(
        {
          ...r,
          requestId: 'bad',
          operation: { ...r.operation!, input: { ...input, requestId: 'bad', key: 'secret' } },
        } as never,
        null,
      ),
    ),
  ).toThrow('invalid service owner receipt');
});
it('pages at the canonical character budget without skipping the first omitted intent', () => {
  const f = fixture();
  const url = 'https://example.com/' + 'x'.repeat(4000);
  f.store.atomic((tx) => {
    for (let n = 0; n < 100; n++) {
      const requestId = String(n).padStart(3, '0');
      const input = {
        requestId,
        connectionId: 'target',
        expectedVersions: null,
        name: 'x'.repeat(256),
        configuration: { kind: 'http' as const, url },
        metadataPermission: 'none' as const,
      };
      tx.putOwnerReceipt(
        {
          ...receipt,
          requestId,
          operation: { method: 'service.connection-set', input, requiresKey: true },
        },
        null,
      );
    }
  });
  const first = f.settings.operations({ limit: 100 });
  expect(first.items.length).toBeGreaterThan(50);
  expect(first.items.length).toBeLessThan(100);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(400000);
  expect(first.next).toBe(first.items.at(-1)?.requestId);
  const second = f.settings.operations({ limit: 100, after: first.next! });
  expect(second.next).toBeNull();
  expect([...first.items, ...second.items].map((i) => i.requestId)).toEqual(
    Array.from({ length: 100 }, (_, n) => String(n).padStart(3, '0')),
  );
  expect(f.settings.operations({}).items).toHaveLength(50);
});
