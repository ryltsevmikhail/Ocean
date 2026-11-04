/**
 * Durable plugin catalog adapter.
 *
 * Enabling a version is one immediate transaction that disables any other
 * version of the same plugin and, when the authority moved, revokes every active
 * grant plus pending confirmation. Startup recovery therefore never reopens an
 * old authority silently.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginCatalogStorePort,
  PluginInstalledFile,
  PluginInstalledVersion,
  PluginInstallState,
} from '@runnets/application';
import {
  readEnabled,
  readVersion,
  revokeConfirmationsForPlugin,
  revokeGrantsForPlugin,
  versionRow,
} from './plugin-reads.js';
import { withImmediateTransaction } from './transaction.js';

export class SqlitePluginCatalog implements PluginCatalogStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  plugins(): readonly string[] {
    return this.#db
      .prepare('SELECT DISTINCT plugin_id FROM ocean_plugin_versions ORDER BY plugin_id')
      .all()
      .map((row) => String(row['plugin_id']));
  }
  versions(pluginId: string): readonly PluginInstalledVersion[] {
    return this.#db
      .prepare('SELECT * FROM ocean_plugin_versions WHERE plugin_id = ? ORDER BY version')
      .all(pluginId)
      .map((row) => versionRow(row))
      .filter((row): row is PluginInstalledVersion => row !== null);
  }
  version(pluginId: string, version: string): PluginInstalledVersion | null {
    return readVersion(this.#db, pluginId, version);
  }
  enabled(pluginId: string): PluginInstalledVersion | null {
    return readEnabled(this.#db, pluginId);
  }
  beginInstall(version: PluginInstalledVersion): void {
    withImmediateTransaction(this.#db, () => {
      const existing = readVersion(this.#db, version.pluginId, version.version);
      if (existing !== null && existing.state !== 'corrupt') throw Error('already_installed');
      this.#db
        .prepare('DELETE FROM ocean_plugin_versions WHERE plugin_id = ? AND version = ?')
        .run(version.pluginId, version.version);
      this.#db
        .prepare(
          `INSERT INTO ocean_plugin_versions
           (plugin_id, version, publisher, title, manifest_digest, manifest, adapter, state,
            enabled, file_digest, installed_at, verified_at)
           VALUES (?,?,?,?,?,?,?,'installing',0,NULL,?,NULL)`,
        )
        .run(
          version.pluginId,
          version.version,
          version.publisher,
          version.title,
          version.manifestDigest,
          JSON.stringify(version.manifest),
          JSON.stringify(version.adapter),
          version.installedAt,
        );
    });
  }
  markVerified(
    pluginId: string,
    version: string,
    file: PluginInstalledFile,
    verifiedAt: string,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE ocean_plugin_versions
         SET state = 'installed', file_digest = ?, verified_at = ?
         WHERE plugin_id = ? AND version = ? AND state IN ('installing','interrupted')`,
      )
      .run(file.sha256, verifiedAt, pluginId, version);
    return result.changes === 1;
  }
  setState(pluginId: string, version: string, state: PluginInstallState): void {
    this.#db
      .prepare('UPDATE ocean_plugin_versions SET state = ? WHERE plugin_id = ? AND version = ?')
      .run(state, pluginId, version);
  }
  setEnabled(
    pluginId: string,
    version: string,
    enabled: boolean,
    at: string,
    revoke: boolean,
  ): number {
    return withImmediateTransaction(this.#db, () => {
      if (enabled)
        this.#db
          .prepare(
            'UPDATE ocean_plugin_versions SET enabled = 0 WHERE plugin_id = ? AND version <> ?',
          )
          .run(pluginId, version);
      this.#db
        .prepare('UPDATE ocean_plugin_versions SET enabled = ? WHERE plugin_id = ? AND version = ?')
        .run(enabled ? 1 : 0, pluginId, version);
      if (!revoke) return 0;
      const grants = revokeGrantsForPlugin(this.#db, pluginId, at);
      revokeConfirmationsForPlugin(this.#db, pluginId, at);
      return grants;
    });
  }
}
