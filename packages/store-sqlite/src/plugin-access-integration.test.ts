import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqlitePluginCatalog } from './plugin-catalog-storage.js';
import { SqlitePluginConnections } from './plugin-connection-storage.js';
import { SqlitePluginAccess } from './plugin-access-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import { PluginAccessService } from '@runnets/application';
import type { PluginConnectionRecord } from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
const at = '2026-11-04T00:00:00.000Z';

function fixture() {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  new SqliteToolJournal(db);
  db.exec(`
    INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES('bot_dev','ws','dev','Dev','Role','test','test',1);
    INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
    INSERT INTO ocean_members VALUES('ws','room','bot_dev');
  `);
  const catalog = new SqlitePluginCatalog(db);
  catalog.beginInstall({
    pluginId: 'github',
    version: entry.version,
    publisher: entry.publisher,
    title: entry.title,
    manifest: entry.manifest,
    manifestDigest: entry.manifestDigest,
    adapter: entry.adapter,
    state: 'installing',
    enabled: false,
    fileDigest: null,
    installedAt: at,
    verifiedAt: null,
  });
  catalog.markVerified(
    'github',
    entry.version,
    { relativePath: 'manifest.json', sha256: entry.manifestDigest, bytes: 10 },
    at,
  );
  catalog.setEnabled('github', entry.version, true, at, false);
  const connections = new SqlitePluginConnections(db);
  const record: PluginConnectionRecord = {
    id: 'conn_work',
    name: 'work',
    pluginId: 'github',
    pluginVersion: entry.version,
    adapterVersion: 'runnets-executor:1:1.6.11',
    endpoint: entry.manifest.endpoint,
    credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
    accountLabel: 'Work',
    identity: null,
    identityVerified: false,
    state: 'active',
    generation: 1,
    schemaDigest: null,
    tools: null,
    consentedGeneration: 1,
    consentedAt: at,
    lastDiscoveryAt: null,
    createdAt: at,
    updatedAt: at,
  };
  connections.add(record);
  // Only a published (consented, complete) discovery may carry a schema digest.
  connections.publishDiscovery({
    connectionId: 'conn_work',
    expectedGeneration: 1,
    pluginVersion: entry.version,
    adapterVersion: record.adapterVersion,
    schemaDigest: 'a'.repeat(64),
    tools: [
      { name: 'list_issues', description: 'list', inputSchema: null },
      { name: 'issue_read', description: 'read', inputSchema: null },
    ],
    identity: { identity: null, verified: false },
    discoveredAt: at,
  });
  const access = new SqlitePluginAccess(db);
  const service = new PluginAccessService({
    store: access,
    clock: { now: () => new Date(at) },
    nextId: (() => {
      let n = 0;
      return () => 'grant_' + String(++n);
    })(),
    sha256: () => 'a'.repeat(64),
  });
  return { db, access, service };
}
const request = (tools: string[], repository = 'team/api') => ({
  workspaceId: 'ws',
  roomId: 'room',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  tools,
  repository,
  acknowledgeGroupVisibility: true,
});

describe('grant re-issue against real SQLite', () => {
  it('revokes the previous active grant and inserts the new one atomically', () => {
    const { access, service } = fixture();
    const first = service.grant(request(['list_issues']));
    const second = service.grant(request(['list_issues', 'issue_read'], 'team/other'));
    expect(first.state).toBe('active');
    expect(second.state).toBe('active');
    const stored = access.grants();
    expect(stored.find((grant) => grant.id === first.id)?.state).toBe('revoked');
    expect(stored.find((grant) => grant.id === first.id)?.revokedAt).toBe(second.createdAt);
    expect(stored.find((grant) => grant.id === second.id)).toMatchObject({
      state: 'active',
      repository: 'team/other',
      tools: ['list_issues', 'issue_read'],
    });
    expect(stored.filter((grant) => grant.state === 'active')).toHaveLength(1);
  });

  it('supports repeated re-issues and keeps exactly one active grant per bot/room/plugin', () => {
    const { access, service } = fixture();
    const ids: string[] = [];
    for (const repository of ['team/a', 'team/b', 'team/c'])
      ids.push(service.grant(request(['list_issues'], repository)).id);
    const stored = access.grants();
    expect(stored).toHaveLength(3);
    for (const id of ids.slice(0, -1))
      expect(stored.find((grant) => grant.id === id)?.state).toBe('revoked');
    expect(stored.filter((grant) => grant.state === 'active')).toHaveLength(1);
    expect(stored.find((grant) => grant.id === ids.at(-1))?.repository).toBe('team/c');
  });
});
