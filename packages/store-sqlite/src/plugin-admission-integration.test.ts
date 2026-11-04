import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqlitePluginCatalog } from './plugin-catalog-storage.js';
import { SqlitePluginConnections } from './plugin-connection-storage.js';
import { SqlitePluginAccess } from './plugin-access-storage.js';
import { SqlitePluginAdmission } from './plugin-admission-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import {
  PluginAccessService,
  PluginCallAdmissionService,
  type PluginConnectionRecord,
  type ServicePluginCatalog,
  type ServicePluginInvokeOutcome,
  type ServicePluginTransportPort,
} from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
const at = '2026-11-04T00:00:00.000Z';
const ADAPTER = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  sdkVersion: '1.6.11',
  manifestSchemaVersion: 1,
} as const;

function countingTransport() {
  const counts = { discover: 0, invoke: 0 };
  const transport: ServicePluginTransportPort = {
    qualification: () => ({ qualified: true, reason: null, identities: {} }),
    async discover(): Promise<ServicePluginCatalog> {
      counts.discover++;
      throw Error('not expected in admission tests');
    },
    async invoke(): Promise<ServicePluginInvokeOutcome> {
      counts.invoke++;
      return {
        kind: 'observed',
        invocationId: 'invocation',
        code: 'ok',
        result: { ok: true },
        vendorErrorCode: null,
      };
    },
  };
  return { transport, counts };
}

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
  const connection: PluginConnectionRecord = {
    id: 'conn_work',
    name: 'work',
    pluginId: 'github',
    pluginVersion: entry.version,
    adapterVersion: 'runnets-executor:1:1.6.11',
    endpoint: entry.manifest.endpoint,
    credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
    accountLabel: null,
    identity: null,
    identityVerified: false,
    state: 'active',
    generation: 1,
    schemaDigest: null,
    tools: null,
    consentedGeneration: null,
    consentedAt: null,
    lastDiscoveryAt: null,
    createdAt: at,
    updatedAt: at,
  };
  connections.add(connection);
  connections.publishDiscovery({
    connectionId: connection.id,
    expectedGeneration: 1,
    pluginVersion: entry.version,
    adapterVersion: connection.adapterVersion,
    schemaDigest: 'a'.repeat(64),
    tools: [
      { name: 'list_issues', description: 'list', inputSchema: null },
      { name: 'issue_read', description: 'read', inputSchema: null },
    ],
    identity: { identity: null, verified: false },
    discoveredAt: at,
  });
  const access = new SqlitePluginAccess(db);
  const accessService = new PluginAccessService({
    store: access,
    clock: { now: () => new Date(at) },
    nextId: (() => {
      let n = 0;
      return () => 'grant_' + String(++n);
    })(),
    sha256: () => 'a'.repeat(64),
  });
  const journal = new SqliteToolJournal(db);
  const transport = countingTransport();
  const admission = new PluginCallAdmissionService({
    store: new SqlitePluginAdmission(db),
    transport: transport.transport,
    credentials: { available: () => true },
    adapter: ADAPTER,
  });
  return { db, accessService, access, connections, journal, transport, admission };
}

const call = (grantId: string, overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws',
  roomId: 'room',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  grantId,
  tool: 'list_issues',
  arguments: { owner: 'team', repo: 'api' },
  claim: { invocationId: 'invocation-1', taskRunId: 'task_run_1', attemptId: 'attempt-1' },
  ...overrides,
});

describe('admission service against real SQLite and the durable journal', () => {
  it('admits one allowed call, settles the journal and records the outcome', async () => {
    const { accessService, journal, transport, admission } = fixture();
    const grant = accessService.grant({
      workspaceId: 'ws',
      roomId: 'room',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: 'conn_work',
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    const result = await admission.call(call(grant.id));
    expect(result.admitted).toBe(true);
    expect(result.outcome?.kind).toBe('observed');
    expect(transport.counts.invoke).toBe(1);
    expect(journal.inspectPending()).toHaveLength(0);
  });

  it('denies wrong repository, revoked grant and disconnected connection with zero invokes', async () => {
    const { accessService, connections, transport, admission } = fixture();
    const grant = accessService.grant({
      workspaceId: 'ws',
      roomId: 'room',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: 'conn_work',
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    const wrongRepository = await admission.call(
      call(grant.id, { arguments: { owner: 'team', repo: 'other' } }),
    );
    expect(wrongRepository.code).toBe('grant_mismatch');
    accessService.revoke(grant.id);
    const revoked = await admission.call(call(grant.id));
    expect(revoked.code).toBe('grant_revoked');
    const second = accessService.grant({
      workspaceId: 'ws',
      roomId: 'room',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: 'conn_work',
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    const disconnected = connections.disconnect('conn_work', at);
    expect(disconnected.revokedGrants).toBe(1);
    const afterDisconnect = await admission.call(call(second.id));
    expect(afterDisconnect.code).toBe('connection_inactive');
    expect(transport.counts.invoke).toBe(0);
  });
});
