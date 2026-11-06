import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ServiceOwnerSettings } from '@runnets/application';
import { SqliteServiceAuthority } from './service-authority-storage.js';
import { initializeSchema } from './schema.js';
import { serviceConnection } from '../../../test-fixtures/service-authority.js';
import type { ProviderSecretStorePort } from '@runnets/application';
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const request = {
  requestId: 'save',
  connectionId: 'test',
  expectedVersions: null,
  name: 'Owned',
  configuration: { kind: 'http' as const, url: 'http://127.0.0.1:1/mcp' },
  metadataPermission: 'none' as const,
  key: 'synthetic-secret-A',
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  const store = new SqliteServiceAuthority(db),
    entries = new Map<string, string>();
  let writes = 0,
    fail = false;
  const secrets: ProviderSecretStorePort = {
    read: (ref) =>
      entries.has(ref) ? { status: 'ok', key: entries.get(ref)! } : { status: 'absent' },
    write(ref, key) {
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM ocean_service_owner_receipts WHERE state='prepared'")
          .get()?.['n'],
      ).toBe(1);
      if (writes === 0) expect(store.atomic((tx) => tx.connection('test'))).toBeNull();
      writes++;
      if (fail) throw Error('provider_write_failed');
      entries.set(ref, key);
    },
    replace() {
      throw Error('unused');
    },
    remove() {
      throw Error('unused');
    },
  };
  let ids = 0;
  const options = {
    store,
    secrets,
    ownerId: 'owner',
    now: Date.now,
    sha256: hash,
    nextId: () => 'ownedref' + ++ids,
    writable: () => true,
    refresh: async () => {
      throw Error('unused');
    },
  };
  return {
    db,
    store,
    entries,
    options,
    service: new ServiceOwnerSettings(options),
    writes: () => writes,
    fail: () => {
      fail = true;
    },
  };
}
it('persists intent before private publication, retains original receipts independently and uses fresh immutable references', () => {
  const f = fixture();
  const first = f.service.setConnection(request);
  expect(first.state).toBe('completed');
  expect(f.writes()).toBe(1);
  const second = new ServiceOwnerSettings(f.options);
  expect(second.setConnection(request)).toEqual(first);
  const { configRevision, trustRevision, credentialRevision } = f.store.atomic((tx) =>
    tx.connection('test'),
  )!;
  const c = { configRevision, trustRevision, credentialRevision };
  const rotated = second.setConnection({
    ...request,
    requestId: 'rotate',
    expectedVersions: c,
    key: 'synthetic-secret-B',
  });
  expect(rotated.result).toMatchObject({
    credentialRevision: 2,
    trustRevision: 2,
    trust: { identity: { status: 'unverified' } },
  });
  expect(second.receipt('save')).toEqual(first);
  expect(f.entries.size).toBe(2);
  const stored = f.db.prepare('SELECT record FROM ocean_service_owner_receipts').all();
  expect(JSON.stringify(stored)).not.toContain(request.key);
  expect(JSON.stringify(stored)).not.toContain('synthetic-secret-B');
});
it.each(['publication', 'final-commit'])(
  'interruption during %s leaves a prepared operation inert and never resubmits it',
  (phase) => {
    const f = fixture();
    if (phase === 'publication') f.fail();
    else
      f.db.exec(
        "CREATE TRIGGER fail_owner BEFORE INSERT ON ocean_service_connections BEGIN SELECT RAISE(ABORT,'synthetic final commit failure'); END",
      );
    expect(() => f.service.setConnection(request)).toThrow();
    expect(f.store.atomic((tx) => tx.connection('test'))).toBeNull();
    const restarted = new ServiceOwnerSettings(f.options);
    expect(restarted.setConnection(request)).toMatchObject({
      state: 'prepared',
      recovery: 'explicit_recovery_required',
    });
    expect(f.writes()).toBe(1);
    expect(() => restarted.setConnection({ ...request, key: 'changed' })).toThrow(
      'request_conflict',
    );
    expect(f.store.atomic((tx) => tx.listGrants())).toEqual([]);
  },
);
it('foreign and restored mutations fail before private publication and connection updates', () => {
  const f = fixture();
  f.store.atomic((tx) =>
    tx.putConnection(
      { ...serviceConnection, trust: { ...serviceConnection.trust, ownerId: 'foreign' } },
      null,
    ),
  );
  expect(() =>
    f.service.setConnection({
      ...request,
      connectionId: serviceConnection.id,
      expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
    }),
  ).toThrow('connection_conflict');
  const restored = new ServiceOwnerSettings({ ...f.options, writable: () => false });
  expect(() => restored.setConnection(request)).toThrow('service_settings_unavailable');
  expect(f.writes()).toBe(0);
  expect(restored.connections()).toEqual([]);
});
it('replaying a disconnect receipt cannot disconnect an independent later generation', () => {
  const f = fixture();
  let cleanups = 0;
  const service = new ServiceOwnerSettings({
    ...f.options,
    disconnect: () => {
      cleanups++;
    },
  });
  const { key: _key, ...metadata } = request;
  service.setConnection(metadata);
  const expectedVersions = { configRevision: 1, trustRevision: 1, credentialRevision: 1 };
  const input = { requestId: 'off', connectionId: 'test', expectedVersions };
  const first = service.disconnect(input);
  expect(cleanups).toBe(1);
  service.setConnection({
    ...metadata,
    requestId: 'reconnect',
    expectedVersions: { configRevision: 2, trustRevision: 1, credentialRevision: 1 },
  });
  expect(service.disconnect(input)).toEqual(first);
  expect(cleanups).toBe(1);
});
