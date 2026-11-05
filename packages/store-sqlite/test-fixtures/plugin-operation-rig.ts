/* eslint-disable no-restricted-imports -- Real-SQLite fixture rig for Task 6 journal tests. */
/**
 * One real-SQLite plugin authority fixture: enabled card, published discovery,
 * one repository grant, admission service, journal and operation views.
 */
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PluginAccessService,
  PluginCallAdmissionService,
  PluginOperationsService,
  type PluginConnectionRecord,
  type ServicePluginCatalog,
  type ServicePluginInvokeOutcome,
  type ServicePluginTransportPort,
} from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from '../src/schema.js';
import { SqlitePluginAccess } from '../src/plugin-access-storage.js';
import { SqlitePluginAdmission } from '../src/plugin-admission-storage.js';
import { SqlitePluginCatalog } from '../src/plugin-catalog-storage.js';
import { SqlitePluginConnections } from '../src/plugin-connection-storage.js';
import { SqlitePluginOperations } from '../src/plugin-operations-storage.js';
import { SqliteToolJournal } from '../src/tool-journal.js';

export const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
export const at = '2026-11-04T00:00:00.000Z';
const ADAPTER = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  sdkVersion: '1.6.11',
  manifestSchemaVersion: 1,
} as const;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const clock = { now: () => new Date(at) };

export const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
export function store(path = ':memory:'): DatabaseSync {
  const db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  new SqliteToolJournal(db);
  db.exec(`
    INSERT INTO ocean_workspace VALUES(1,'ws','/project');
    INSERT INTO ocean_bots VALUES('bot_dev','ws','dev','Dev','Role','test','test',1);
    INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
    INSERT INTO ocean_members VALUES('ws','room','bot_dev');
  `);
  return db;
}

export function countingTransport(outcome?: () => ServicePluginInvokeOutcome) {
  const counts = { discover: 0, invoke: 0 };
  const transport: ServicePluginTransportPort = {
    qualification: () => ({ qualified: true, reason: null, identities: {} }),
    async discover(): Promise<ServicePluginCatalog> {
      counts.discover++;
      throw Error('unexpected discovery');
    },
    async invoke(): Promise<ServicePluginInvokeOutcome> {
      counts.invoke++;
      return outcome === undefined
        ? {
            kind: 'observed',
            invocationId: 'invocation',
            code: 'ok',
            result: { items: [{ number: 7, title: 'Bug' }] },
            vendorErrorCode: null,
          }
        : outcome();
    },
  };
  return { transport, counts };
}

export function fixture(outcome?: () => ServicePluginInvokeOutcome) {
  const db = store();
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
    tools: [{ name: 'list_issues', description: 'list', inputSchema: null }],
    identity: { identity: null, verified: false },
    discoveredAt: at,
  });
  const access = new SqlitePluginAccess(db);
  const accessService = new PluginAccessService({
    store: access,
    clock,
    nextId: (() => {
      let n = 0;
      return () => 'grant_' + String(++n);
    })(),
    sha256: () => 'a'.repeat(64),
  });
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
  const journal = new SqliteToolJournal(db);
  const { transport, counts } = countingTransport(outcome);
  const admission = new PluginCallAdmissionService({
    store: new SqlitePluginAdmission(db),
    transport,
    credentials: { available: () => true },
    adapter: ADAPTER,
    now: () => at,
    sha256,
  });
  const operations = new PluginOperationsService({
    store: new SqlitePluginOperations(db),
    clock,
  });
  const call = (invocationId: string) =>
    admission.call({
      workspaceId: 'ws',
      roomId: 'room',
      botId: 'bot_dev',
      pluginId: 'github',
      connectionId: 'conn_work',
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'api' },
      claim: { invocationId, taskRunId: 'task_run_1', attemptId: 'attempt-1' },
    });
  return { db, connections, journal, admission, operations, counts, grant, call };
}
