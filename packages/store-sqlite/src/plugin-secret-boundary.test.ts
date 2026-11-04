import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqlitePluginCatalog } from './plugin-catalog-storage.js';
import { SqlitePluginConnections } from './plugin-connection-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import type { PluginConnectionRecord } from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
const canary = 'CANARY_SQLITE_CREDENTIAL_4b7c';
const credentialReference = 'OCEAN_GITHUB_WORK_TOKEN';
const at = '2026-11-04T00:00:00.000Z';

describe('plugin credential boundary in SQLite', () => {
  it('stores the environment reference but never the credential value', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-plugin-secret-'));
    roots.push(root);
    const path = join(root, 'runtime.sqlite');
    const db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
    new SqliteToolJournal(db);
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
    const record: PluginConnectionRecord = {
      id: 'conn_work',
      name: 'work',
      pluginId: 'github',
      pluginVersion: entry.version,
      adapterVersion: 'runnets-executor:1:1.6.11',
      endpoint: entry.manifest.endpoint,
      credentialReference,
      accountLabel: 'Work',
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
    new SqlitePluginConnections(db).add(record);
    // The credential value exists only in the process environment, never in the database.
    process.env[credentialReference] = canary;
    try {
      db.close();
      databases.splice(databases.indexOf(db), 1);
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
      expect(bytes.includes(Buffer.from(credentialReference))).toBe(true);
      expect(bytes.includes(Buffer.from('OCEAN_GITHUB_WORK_TOKEN'))).toBe(true);
    } finally {
      delete process.env[credentialReference];
    }
  });
});
