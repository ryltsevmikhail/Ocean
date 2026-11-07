import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceAuthorityTransaction } from '@runnets/application';
import {
  ownerGrant,
  serviceCatalog,
  serviceConnection,
  authorityVersions,
} from '../../../test-fixtures/service-authority.js';
import { openSqliteStore, type SqliteStore } from './store.js';
const stores: SqliteStore[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(path = ':memory:') {
  const s = openSqliteStore({ path });
  stores.push(s);
  return s;
}
function seed(s: SqliteStore) {
  s.serviceAuthority.atomic((tx) => {
    expect(tx.putConnection(serviceConnection, null)).toBe(true);
    expect(tx.putGrant(ownerGrant, null)).toBe(true);
  });
}

describe('inert durable service authority', () => {
  it('creates and reads defensive snapshots on the existing store', () => {
    const s = open();
    seed(s);
    s.serviceAuthority.atomic((tx) => {
      const snapshot = tx.connection('third')!;
      Object.assign(snapshot, { name: 'mutated outside storage' });
      expect(tx.connection('third')).toEqual(serviceConnection);
      expect(tx.listConnections()).toEqual([serviceConnection]);
      expect(tx.listGrants()).toEqual([ownerGrant]);
      expect(tx.grant('missing')).toBeNull();
      expect(
        tx.putGrant(
          {
            ...ownerGrant,
            id: 'coding',
            permissions: [
              {
                kind: 'coding',
                actions: ['project_read'],
                resources: [{ kind: 'project-worktree', projectId: 'project', worktreeId: null }],
              },
            ],
          },
          null,
        ),
      ).toBe(true);
    });
  });
  it('publishes only complete immutable same-connection exact-version snapshots', () => {
    const s = open();
    seed(s);
    s.serviceAuthority.atomic((tx) => {
      expect(tx.putConnection({ ...serviceConnection, id: 'other' }, null)).toBe(true);
      expect(tx.putCatalog(serviceCatalog)).toBe(true);
      expect(tx.putCatalog(serviceCatalog)).toBe(true);
      expect(tx.publishCatalog('other', authorityVersions, 'catalog')).toBe(false);
      expect(
        tx.publishCatalog('third', { ...authorityVersions, trustRevision: 2 }, 'catalog'),
      ).toBe(false);
      expect(tx.publishCatalog('third', authorityVersions, 'missing')).toBe(false);
      expect(tx.putCatalog({ ...serviceCatalog, id: 'stale-catalog', configRevision: 2 })).toBe(
        true,
      );
      expect(tx.publishCatalog('third', authorityVersions, 'stale-catalog')).toBe(false);
      expect(tx.connection('third')?.currentCatalogId).toBeNull();
      expect(tx.publishCatalog('third', authorityVersions, 'catalog')).toBe(true);
      expect(tx.catalog('catalog')).toEqual(serviceCatalog);
      expect(tx.connection('third')?.currentCatalogId).toBe('catalog');
    });
    expect(() =>
      s.serviceAuthority.atomic((tx) => tx.putCatalog({ ...serviceCatalog, tools: [] })),
    ).toThrow(/immutable/);
    expect(() =>
      s.serviceAuthority.atomic((tx) =>
        tx.putCatalog({
          ...serviceCatalog,
          id: 'partial',
          completeness: 'partial',
        } as unknown as typeof serviceCatalog),
      ),
    ).toThrow(/invalid/);
    expect(s.serviceAuthority.atomic((tx) => tx.connection('third')?.currentCatalogId)).toBe(
      'catalog',
    );
  });
  it('refuses stale connection tuples and unversioned axis changes', () => {
    const s = open();
    seed(s);
    s.serviceAuthority.atomic((tx) => {
      const changed = {
        ...serviceConnection,
        credentialRevision: 2,
        credentialReference: 'env:ROTATED_TOKEN',
      };
      expect(tx.putConnection(changed, authorityVersions)).toBe(true);
      expect(tx.putConnection(serviceConnection, authorityVersions)).toBe(false);
      expect(
        tx.putConnection(
          { ...changed, configuration: { kind: 'http' as const, url: 'https://new.example/mcp' } },
          { ...authorityVersions, credentialRevision: 2 },
        ),
      ).toBe(false);
      expect(
        tx.putConnection(
          { ...changed, currentCatalogId: 'forged' },
          { ...authorityVersions, credentialRevision: 2 },
        ),
      ).toBe(false);
      expect(tx.putConnection(serviceConnection, null)).toBe(false);
      expect(tx.putConnection(changed, { ...authorityVersions, credentialRevision: 2 })).toBe(
        false,
      );
      expect(
        tx.putConnection(
          { ...changed, name: 'renamed', trustRevision: 2 },
          { ...authorityVersions, credentialRevision: 2 },
        ),
      ).toBe(false);
      expect(tx.publishCatalog('third', authorityVersions, 'catalog')).toBe(false);
      expect(tx.grant('grant')).toEqual(ownerGrant);
    });
  });
  it('persists revision 2 across reopen and refuses stale writers without policy or pointer changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'authority-'));
    dirs.push(dir);
    const path = join(dir, 'db');
    const first = open(path);
    seed(first);
    const second = open(path);
    const stale = second.serviceAuthority.atomic((tx) => tx.grant('grant'))!;
    const oldConnection = second.serviceAuthority.atomic((tx) => tx.connection('third'))!;
    first.serviceAuthority.atomic((tx) => {
      tx.putCatalog(serviceCatalog);
      tx.publishCatalog('third', authorityVersions, 'catalog');
      expect(tx.putGrant({ ...ownerGrant, revision: 2, mode: 'confirm' }, 1)).toBe(true);
    });
    expect(
      second.serviceAuthority.atomic((tx) =>
        tx.putGrant({ ...stale, revision: 2, permissions: [] }, 1),
      ),
    ).toBe(false);
    expect(second.serviceAuthority.atomic((tx) => tx.putGrant({ ...stale, revision: 2 }, 1))).toBe(
      false,
    );
    expect(second.serviceAuthority.atomic((tx) => tx.putGrant(stale, 1))).toBe(false);
    first.serviceAuthority.atomic((tx) => {
      const current = tx.connection('third')!;
      expect(
        tx.putConnection(
          { ...current, credentialRevision: 2, credentialReference: 'env:ROTATED_TOKEN' },
          authorityVersions,
        ),
      ).toBe(true);
    });
    expect(
      second.serviceAuthority.atomic((tx) =>
        tx.putConnection({ ...oldConnection, configRevision: 2 }, authorityVersions),
      ),
    ).toBe(false);
    expect(
      second.serviceAuthority.atomic((tx) => tx.putGrant({ ...ownerGrant, revision: 1 }, 2)),
    ).toBe(false);
    first.close();
    second.close();
    const reopened = open(path);
    expect(reopened.serviceAuthority.atomic((tx) => tx.grant('grant'))?.revision).toBe(2);
    expect(reopened.serviceAuthority.atomic((tx) => tx.grant('grant'))?.mode).toBe('confirm');
    expect(reopened.serviceAuthority.atomic((tx) => tx.connection('third'))?.currentCatalogId).toBe(
      'catalog',
    );
  });
  it('catalog, adapter provenance and credential changes do not rewrite owner grants', () => {
    const s = open();
    seed(s);
    s.serviceAuthority.atomic((tx) => {
      tx.putCatalog(serviceCatalog);
      tx.publishCatalog('third', authorityVersions, 'catalog');
      tx.putCatalog({
        ...serviceCatalog,
        id: 'catalog-2',
        provenance: { adapter: 'new-sdk-evidence' },
        tools: [],
      });
      tx.publishCatalog('third', authorityVersions, 'catalog-2');
      const connection = tx.connection('third')!;
      tx.putConnection(
        { ...connection, credentialReference: 'env:NEW_TOKEN', credentialRevision: 2 },
        authorityVersions,
      );
      expect(tx.grant('grant')).toEqual(ownerGrant);
    });
  });
  it('rolls back a failed batch and refuses an escaped transaction after commit or rollback', () => {
    const s = open();
    let captured: ServiceAuthorityTransaction | undefined;
    expect(() =>
      s.serviceAuthority.atomic((tx) => {
        captured = tx;
        tx.putConnection(serviceConnection, null);
        throw Error('stop');
      }),
    ).toThrow('stop');
    expect(() => captured?.putGrant(ownerGrant, null)).toThrow(/closed/);
    expect(s.serviceAuthority.atomic((tx) => tx.connection('third'))).toBeNull();
    s.serviceAuthority.atomic((tx) => {
      captured = tx;
      tx.putConnection(serviceConnection, null);
    });
    expect(() => captured?.putGrant(ownerGrant, null)).toThrow(/closed/);
    expect(() =>
      s.serviceAuthority.atomic(async (tx) => {
        tx.putGrant(ownerGrant, null);
      }),
    ).toThrow(/synchronous/);
    expect(s.serviceAuthority.atomic((tx) => tx.grant('grant'))).toBeNull();
  });
});
