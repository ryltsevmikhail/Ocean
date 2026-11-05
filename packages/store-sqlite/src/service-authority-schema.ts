import type { DatabaseSync } from 'node:sqlite';
export const SERVICE_AUTHORITY_TABLES = [
  'ocean_service_connections',
  'ocean_service_catalogs',
  'ocean_owner_scope_grants',
] as const;
/** Migration 24 is additive and inert: no legacy authority is converted. */
export function migrateServiceAuthority(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ocean_service_connections (
      id TEXT PRIMARY KEY,
      config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
      trust_revision INTEGER NOT NULL CHECK(trust_revision >= 1),
      credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
      current_catalog_id TEXT,
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536),
      FOREIGN KEY(id, current_catalog_id) REFERENCES ocean_service_catalogs(connection_id, id)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ocean_service_catalogs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ocean_service_connections(id),
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 4194304),
      UNIQUE(connection_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ocean_owner_scope_grants (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536)
    ) STRICT;
  `);
}
