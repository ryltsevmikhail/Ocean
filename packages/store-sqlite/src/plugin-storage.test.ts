import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqlitePluginCatalog } from './plugin-catalog-storage.js';
import { SqlitePluginConnections } from './plugin-connection-storage.js';
import { SqlitePluginAccess } from './plugin-access-storage.js';
import { SqlitePluginAdmission } from './plugin-admission-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import { readMaintenancePluginInventory } from './plugin-backup-inventory.js';
import type { PluginConnectionRecord, PluginInstalledVersion } from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG, type PluginGrantRecord } from '@runnets/domain';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
function memory(): DatabaseSync {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  seedConversation(db);
  return db;
}
function seedConversation(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES('bot_dev','ws','dev','Dev','Role','test','test',1);
    INSERT INTO ocean_bots VALUES('bot_review','ws','review','Review','Role','test','test',1);
    INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
    INSERT INTO ocean_members VALUES('ws','room','bot_dev'),('ws','room','bot_review');
  `);
}
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
const at = '2026-11-04T00:00:00.000Z';
function installVersion(
  catalog: SqlitePluginCatalog,
  version = entry.version,
  digest = entry.manifestDigest,
): PluginInstalledVersion {
  catalog.beginInstall({
    pluginId: 'github',
    version,
    publisher: entry.publisher,
    title: entry.title,
    manifest: { ...entry.manifest, version },
    manifestDigest: digest,
    adapter: entry.adapter,
    state: 'installing',
    enabled: false,
    fileDigest: null,
    installedAt: at,
    verifiedAt: null,
  });
  expect(
    catalog.markVerified(
      'github',
      version,
      { relativePath: 'manifest.json', sha256: digest, bytes: 10 },
      at,
    ),
  ).toBe(true);
  return catalog.version('github', version)!;
}
function connection(digest: string | null = null): PluginConnectionRecord {
  return {
    id: 'conn_work',
    name: 'work',
    pluginId: 'github',
    pluginVersion: entry.version,
    adapterVersion: 'runnets-executor:1:1.6.11',
    endpoint: entry.manifest.endpoint,
    credentialReference: 'OCEAN_TEST_PRESENT',
    accountLabel: 'Work',
    identity: null,
    identityVerified: false,
    state: 'active',
    generation: 1,
    schemaDigest: digest,
    tools: digest === null ? null : [],
    consentedGeneration: null,
    consentedAt: null,
    lastDiscoveryAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function grant(scopes: Partial<PluginGrantRecord> = {}): PluginGrantRecord {
  return {
    id: 'grant_1',
    workspaceId: 'ws',
    roomId: 'room',
    botId: 'bot_dev',
    pluginId: 'github',
    connectionId: 'conn_work',
    connectionGeneration: 1,
    tools: ['list_issues'],
    repository: 'team/api',
    schemaDigest: 'a'.repeat(64),
    policyVersion: 1,
    visibility: 'Everyone in the group chat',
    state: 'active',
    createdAt: at,
    revokedAt: null,
    ...scopes,
  };
}

describe('sqlite plugin catalog storage', () => {
  it('tracks install intent, verification, enabled versions and revocations atomically', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog, entry.version, 'b'.repeat(64));
    installVersion(catalog, '1.1.0', 'c'.repeat(64));
    const access = new SqlitePluginAccess(db);
    new SqlitePluginConnections(db).add(connection());
    access.atomic((tx) => tx.putGrant(grant({ schemaDigest: 'b'.repeat(64) })));
    access.seedPendingConfirmation('confirmation-1', 'conn_work', 1, at);
    const revoked = catalog.setEnabled('github', '1.1.0', true, at, true);
    expect(revoked).toBe(1);
    expect(catalog.enabled('github')?.version).toBe('1.1.0');
    expect(access.grants()[0]?.state).toBe('revoked');
    expect(access.pendingConfirmations()?.[0]?.state).toBe('revoked');
    expect(catalog.setEnabled('github', entry.version, true, at, true)).toBe(0);
    expect(catalog.enabled('github')?.version).toBe(entry.version);
  });

  it('keeps install intent durable and refuses a second install of an installed version', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    expect(() =>
      catalog.beginInstall({ ...catalog.version('github', entry.version)!, state: 'installing' }),
    ).toThrow('already_installed');
    catalog.setState('github', entry.version, 'corrupt');
    expect(() =>
      catalog.beginInstall({ ...catalog.version('github', entry.version)!, state: 'installing' }),
    ).not.toThrow();
  });
});

describe('sqlite plugin connection storage', () => {
  it('enforces unique names and generation CAS', () => {
    const db = memory();
    const connections = new SqlitePluginConnections(db);
    connections.add(connection());
    expect(() => connections.add({ ...connection(), id: 'other' })).toThrow('connection_exists');
    const changed = connections.change('conn_work', 1, { credentialReference: 'OTHER_REF' }, at);
    expect(changed.generation).toBe(2);
    expect(changed.credentialReference).toBe('OTHER_REF');
    expect(() => connections.change('conn_work', 1, {}, at)).toThrow('connection_changed');
  });

  it('publishes a schema digest once and revokes authority when it moves', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    const connections = new SqlitePluginConnections(db);
    const access = new SqlitePluginAccess(db);
    connections.add(connection());
    connections.consent({
      connectionId: 'conn_work',
      generation: 1,
      endpoint: entry.manifest.endpoint,
      consentedAt: at,
      usedAt: null,
    });
    const first = connections.publishDiscovery({
      connectionId: 'conn_work',
      expectedGeneration: 1,
      pluginVersion: entry.version,
      adapterVersion: 'runnets-executor:1:1.6.11',
      schemaDigest: 'a'.repeat(64),
      tools: [],
      identity: { identity: null, verified: false },
      discoveredAt: at,
    });
    expect(first.authorityChanged).toBe(false);
    expect(first.connection.generation).toBe(1);
    expect(first.connection.schemaDigest).toBe('a'.repeat(64));
    access.atomic((tx) => tx.putGrant(grant()));
    const moved = connections.publishDiscovery({
      connectionId: 'conn_work',
      expectedGeneration: 1,
      pluginVersion: entry.version,
      adapterVersion: 'runnets-executor:1:1.6.11',
      schemaDigest: 'b'.repeat(64),
      tools: [],
      identity: { identity: 'octocat', verified: true },
      discoveredAt: at,
    });
    expect(moved.authorityChanged).toBe(true);
    expect(moved.connection.generation).toBe(2);
    expect(moved.revokedGrants).toBe(1);
    expect(access.grants()[0]?.state).toBe('revoked');
    expect(connections.consents('conn_work')).toEqual([]);
  });

  it('disconnects idempotently and invalidates restored authority', () => {
    const db = memory();
    const connections = new SqlitePluginConnections(db);
    const access = new SqlitePluginAccess(db);
    connections.add(connection());
    access.atomic((tx) => tx.putGrant(grant()));
    const once = connections.disconnect('conn_work', at);
    expect(once.connection.state).toBe('disconnected');
    expect(once.revokedGrants).toBe(1);
    expect(access.grants()[0]?.state).toBe('revoked');
    const twice = connections.disconnect('conn_work', at);
    expect(twice.connection.generation).toBe(once.connection.generation);
    expect(twice.revokedGrants).toBe(0);
    connections.add({ ...connection(), id: 'conn_personal', name: 'personal' });
    connections.invalidateRestored(at);
    expect(connections.get('conn_personal')?.state).toBe('disconnected');
  });
});

describe('sqlite plugin access and admission storage', () => {
  it('rechecks membership and the enabled version inside one immediate transaction', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    catalog.setEnabled('github', entry.version, true, at, false);
    const connections = new SqlitePluginConnections(db);
    connections.add(connection('a'.repeat(64)));
    const access = new SqlitePluginAccess(db);
    expect(access.atomic((tx) => tx.member('ws', 'room', 'bot_dev'))).toBe(true);
    expect(access.atomic((tx) => tx.member('ws', 'room', 'bot_review'))).toBe(true);
    expect(access.atomic((tx) => tx.member('ws', 'other', 'bot_dev'))).toBe(false);
    expect(access.atomic((tx) => tx.enabledVersion('github')?.version)).toBe(entry.version);
    expect(access.atomic((tx) => tx.room('room'))).toEqual({
      id: 'room',
      kind: 'group',
      title: 'Team',
      participantCount: 2,
    });
  });

  it('grants and revokes with a one-way durable transition', () => {
    const db = memory();
    const access = new SqlitePluginAccess(db);
    access.atomic((tx) => tx.putGrantAndRevokePrevious(grant(), at));
    expect(access.grants()).toHaveLength(1);
    access.atomic((tx) => tx.putGrantAndRevokePrevious(grant({ id: 'grant_2' }), at));
    const grants = access.grants();
    expect(grants.find((row) => row.id === 'grant_1')?.state).toBe('revoked');
    expect(grants.find((row) => row.id === 'grant_2')?.state).toBe('active');
    expect(access.revoke('grant_2', at)).toBe(true);
    expect(access.revoke('grant_2', at)).toBe(false);
  });
  it('claims the journal only after the full authority recheck and never on denial', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    catalog.setEnabled('github', entry.version, true, at, false);
    const connections = new SqlitePluginConnections(db);
    connections.add(connection('a'.repeat(64)));
    const access = new SqlitePluginAccess(db);
    access.atomic((tx) => tx.putGrantAndRevokePrevious(grant(), at));
    const admission = new SqlitePluginAdmission(db);
    const journal = new SqliteToolJournal(db);
    const claimRow = (id: string) =>
      db.prepare('SELECT outcome FROM tool_invocations_v2 WHERE id = ?').get(id);
    const context = { taskRunId: 'run-1', attemptId: 'attempt-1' };
    const allowed = admission.atomic((tx) => {
      if (!tx.member('ws', 'room', 'bot_dev')) return false;
      const grantRow = tx.grant('grant_1');
      if (grantRow === null || grantRow.state !== 'active') return false;
      return tx.claim('invocation-1', 'list_issues', context, 'fingerprint');
    });
    expect(allowed).toBe(true);
    expect(claimRow('invocation-1')?.['outcome']).toBe('started');
    admission.settle('invocation-1', 'completed', context);
    expect(claimRow('invocation-1')?.['outcome']).toBe('completed');
    const denied = admission.atomic((tx) => {
      if (!tx.member('ws', 'other', 'bot_dev')) return 'member_required';
      return tx.claim('invocation-2', 'list_issues', context, 'fingerprint');
    });
    expect(denied).toBe('member_required');
    expect(claimRow('invocation-2')).toBeUndefined();
    expect(journal.inspectPending()).toHaveLength(0);
  });
});
describe('plugin backup inventory', () => {
  it('lists authoritative versions and keeps credential values out of the metadata', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    catalog.setEnabled('github', entry.version, true, at, false);
    const inventory = readMaintenancePluginInventory(db);
    expect(inventory.versions).toHaveLength(1);
    expect(inventory.versions[0]).toMatchObject({
      pluginId: 'github',
      version: entry.version,
      state: 'installed',
      enabled: true,
    });
    expect(JSON.stringify(inventory)).not.toContain('OCEAN_TEST');
    expect(inventory.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
