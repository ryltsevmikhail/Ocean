/**
 * Service-plugin schema (migration 17).
 *
 * Ocean owns the authoritative catalog, connection, consent, grant and
 * confirmation rows. No table stores a credential value: `credential_ref` is an
 * environment variable NAME. Grants bind the exact authority snapshot and are
 * revoked in the same transaction as any authority change.
 */

import type { DatabaseSync } from 'node:sqlite';

export const PLUGIN_TABLES = [
  'ocean_plugin_versions',
  'ocean_plugin_connections',
  'ocean_plugin_consents',
  'ocean_plugin_grants',
  'ocean_plugin_confirmations',
] as const;

export function migratePlugins(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ocean_plugin_versions (
      plugin_id TEXT NOT NULL,
      version TEXT NOT NULL,
      publisher TEXT NOT NULL,
      title TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      manifest TEXT NOT NULL,
      adapter TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('installing','installed','interrupted','corrupt')),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      file_digest TEXT,
      installed_at TEXT NOT NULL,
      verified_at TEXT,
      PRIMARY KEY(plugin_id, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ocean_plugin_connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      account_label TEXT,
      identity TEXT,
      identity_verified INTEGER NOT NULL CHECK(identity_verified IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('active','disconnected')),
      generation INTEGER NOT NULL CHECK(generation >= 1),
      schema_digest TEXT,
      tools TEXT,
      consented_generation INTEGER,
      consented_at TEXT,
      last_discovery_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plugin_id, name)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ocean_plugin_consents (
      connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      used_at TEXT,
      PRIMARY KEY(connection_id, generation)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ocean_plugin_grants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      tools TEXT NOT NULL,
      repository TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      visibility TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','revoked')),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK((state = 'revoked') = (revoked_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ocean_plugin_grants_scope
      ON ocean_plugin_grants(workspace_id, room_id, bot_id, state);
    CREATE INDEX IF NOT EXISTS ocean_plugin_grants_connection
      ON ocean_plugin_grants(connection_id, state);
    CREATE INDEX IF NOT EXISTS ocean_plugin_grants_plugin
      ON ocean_plugin_grants(plugin_id, state);

    CREATE TABLE IF NOT EXISTS ocean_plugin_confirmations (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      state TEXT NOT NULL CHECK(state IN ('pending','revoked','consumed')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
  `);
}
