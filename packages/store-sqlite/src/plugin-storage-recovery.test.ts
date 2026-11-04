/**
 * Plugin catalog startup-recovery persistence.
 *
 * Split from `plugin-storage.test.ts` to keep that file inside the 300-line source
 * cap; these cases cover the Task 5 re-review M1 fix (a repaired `corrupt` row must
 * become `installed` so `enable` works, while an unverifiable copy stays terminal).
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';
import { SqlitePluginCatalog } from './plugin-catalog-storage.js';
import { PluginCatalogService } from '@runnets/application';
import type {
  PluginInstalledFile,
  PluginInstallStorePort,
  PluginInstalledVersion,
} from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';

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

describe('plugin catalog startup recovery persistence', () => {
  const pinnedAdapter = entry.adapter;
  function recoveryService(catalog: SqlitePluginCatalog, files: PluginInstallStorePort) {
    return new PluginCatalogService({
      catalog: SHIPPED_PLUGIN_CATALOG,
      store: catalog,
      files,
      adapter: pinnedAdapter,
      clock: { now: () => new Date(at) },
      nextId: () => 'id' + String(Math.random()).slice(2, 10),
      sha256: (text: string) => createHash('sha256').update(text).digest('hex'),
    });
  }
  function manifestFile(): PluginInstalledFile {
    return { relativePath: 'manifest.json', sha256: entry.manifestDigest, bytes: 10 };
  }
  it('persists a repaired corrupt row as installed so enable works', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    catalog.setState('github', entry.version, 'corrupt');
    const files: PluginInstallStorePort = {
      publish: () => manifestFile(),
      repair: () => manifestFile(),
      read: () => ({ status: 'ok', bytes: 10, sha256: entry.manifestDigest }),
    };
    const report = recoveryService(catalog, files).initialize();
    expect(report.repaired).toBe(1);
    expect(report.corrupt).toBe(0);
    expect(catalog.version('github', entry.version)?.state).toBe('installed');
    expect(catalog.setEnabled('github', entry.version, true, at, false)).toBe(0);
    expect(catalog.enabled('github')?.version).toBe(entry.version);
  });
  it('keeps a corrupt row terminal when the copy still does not verify', () => {
    const db = memory();
    const catalog = new SqlitePluginCatalog(db);
    installVersion(catalog);
    catalog.setState('github', entry.version, 'corrupt');
    const files: PluginInstallStorePort = {
      publish: () => manifestFile(),
      repair: () => manifestFile(),
      read: () => ({ status: 'missing', reason: 'absent' }),
    };
    const report = recoveryService(catalog, files).initialize();
    expect(report.corrupt).toBe(1);
    expect(report.repaired).toBe(0);
    expect(catalog.version('github', entry.version)?.state).toBe('corrupt');
  });
});
