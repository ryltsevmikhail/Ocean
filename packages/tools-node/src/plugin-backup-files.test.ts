import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHIPPED_PLUGIN_CATALOG,
  emptyPluginBackupInventory,
  type PluginBackupInventory,
} from '@runnets/domain';
import { createPluginInstallStore } from './plugin-install-store.js';
import {
  archivePluginBackupFiles,
  restorePluginBackupFiles,
  verifyPluginBackupFiles,
} from './plugin-backup-files.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-plugin-archive-'));
  roots.push(root);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const install = createPluginInstallStore({ profile });
  install.publish('github', entry.version, entry.manifest);
  const inventory: PluginBackupInventory = {
    format: 1,
    versions: [
      {
        pluginId: 'github',
        version: entry.version,
        manifestDigest: entry.manifestDigest,
        state: 'installed',
        enabled: false,
      },
    ],
    hash: 'a'.repeat(64),
  };
  return { root, profile, inventory };
}

describe('plugin backup asset archive', () => {
  it('archives verified manifests, verifies them and restores private copies', () => {
    const { root, profile, inventory } = fixture();
    const archive = join(root, 'assets', 'plugins');
    const catalog = archivePluginBackupFiles(inventory, profile, archive);
    expect(catalog.files).toHaveLength(1);
    expect(catalog.inventoryHash).toBe(inventory.hash);
    const archived = join(archive, 'github', entry.version, 'manifest.json');
    expect(statSync(archived).mode & 0o777).toBe(0o600);
    expect(() => verifyPluginBackupFiles(archive, catalog)).not.toThrow();
    const restored = join(root, 'restored');
    restorePluginBackupFiles(archive, restored);
    const copy = join(restored, 'plugins', 'github', entry.version, 'manifest.json');
    expect(statSync(join(restored, 'plugins', 'github', entry.version)).mode & 0o777).toBe(0o700);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(copy).toString('utf8')).toBe(readFileSync(archived).toString('utf8'));
  });

  it('refuses explicitly when a verified manifest cannot be archived', () => {
    const { root, profile, inventory } = fixture();
    rmSync(join(profile, 'plugins', 'github', entry.version), { recursive: true, force: true });
    expect(() =>
      archivePluginBackupFiles(inventory, profile, join(root, 'assets', 'plugins')),
    ).toThrow('plugin_assets_unavailable');
    const empty = emptyPluginBackupInventory();
    const catalog = archivePluginBackupFiles(empty, profile, join(root, 'assets-empty'));
    expect(catalog.files).toEqual([]);
    expect(() => verifyPluginBackupFiles(join(root, 'assets-empty'), catalog)).not.toThrow();
  });

  it('detects tampered or missing archive bytes', () => {
    const { root, profile, inventory } = fixture();
    const archive = join(root, 'assets', 'plugins');
    const catalog = archivePluginBackupFiles(inventory, profile, archive);
    const archived = join(archive, 'github', entry.version, 'manifest.json');
    rmSync(archived);
    expect(() => verifyPluginBackupFiles(archive, catalog)).toThrow('invalid_backup');
  });
});
