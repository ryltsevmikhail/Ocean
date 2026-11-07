import type { DatabaseSync } from 'node:sqlite';
import type { OwnerPermission, OwnerResourceScope } from '@runnets/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerGrant, serviceConnection } from '../../../test-fixtures/service-authority.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function store() {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return new SqliteServiceAuthority(db);
}
describe('durable authority input boundaries', () => {
  it('refuses sparse grant writes before commit and leaves valid grants readable', () => {
    const s = store();
    for (const record of [
      { ...ownerGrant, permissions: Array<OwnerPermission>(1) },
      {
        ...ownerGrant,
        permissions: [
          {
            kind: 'service' as const,
            connectionId: 'third',
            trustRevision: 1,
            tools: { kind: 'exact' as const, names: ['notes.search'] },
            resources: Array<OwnerResourceScope>(1),
          },
        ],
      },
    ])
      expect(() => s.atomic((tx) => tx.putGrant(record, null))).toThrow(/invalid/);
    expect(s.atomic((tx) => tx.listGrants())).toEqual([]);
    expect(s.atomic((tx) => tx.putGrant(ownerGrant, null))).toBe(true);
    expect(s.atomic((tx) => tx.grant('grant'))).toEqual(ownerGrant);
    expect(s.atomic((tx) => tx.listGrants())).toEqual([ownerGrant]);
  });
  it('refuses literal credential argv and raw references, then roundtrips an empty-argv referenced connection', () => {
    const s = store();
    const configuration = {
      kind: 'stdio' as const,
      executable: '/opt/server',
      sha256: 'a'.repeat(64),
      args: [],
    };
    const connection = {
      ...serviceConnection,
      configuration,
      credentialReference: 'env:SERVICE_TOKEN',
    };
    expect(() =>
      s.atomic((tx) =>
        tx.putConnection(
          {
            ...connection,
            configuration: {
              ...configuration,
              args: ['--access-token', 'ghp_ExampleOnlyNotARealCredential'],
            },
          },
          null,
        ),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      s.atomic((tx) =>
        tx.putConnection(
          { ...connection, credentialReference: 'ghp_ExampleOnlyNotARealCredential' },
          null,
        ),
      ),
    ).toThrow(/invalid/);
    expect(s.atomic((tx) => tx.listConnections())).toEqual([]);
    expect(s.atomic((tx) => tx.putConnection(connection, null))).toBe(true);
    expect(s.atomic((tx) => tx.connection('third'))).toEqual(connection);
  });
  it('observes refused promise and callable-thenable rejections after synchronous rollback', async () => {
    const s = store(),
      unhandled: unknown[] = [];
    let resumed = false;
    const observe = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', observe);
    try {
      expect(() =>
        s.atomic(async (tx) => {
          tx.putGrant(ownerGrant, null);
          await Promise.resolve();
          resumed = true;
          tx.putGrant({ ...ownerGrant, revision: 2 }, 1);
        }),
      ).toThrow(/synchronous/);
      expect(() => s.atomic(() => Promise.reject(Error('refused callback')))).toThrow(
        /synchronous/,
      );
      expect(() =>
        s.atomic(() => ({
          then: (_resolve: unknown, reject: (reason: Error) => void) => {
            reject(Error('refused thenable'));
          },
        })),
      ).toThrow(/synchronous/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resumed).toBe(true);
      expect(unhandled).toEqual([]);
      expect(s.atomic((tx) => tx.grant('grant'))).toBeNull();
      expect(s.atomic(() => ({ then: 1 }))).toEqual({ then: 1 });
    } finally {
      process.off('unhandledRejection', observe);
    }
  });
});
