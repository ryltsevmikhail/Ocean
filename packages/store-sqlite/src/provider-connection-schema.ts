/**
 * Provider connection metadata schema (migration 15).
 *
 * The tables keep authoritative intent, revision guards and the one-way
 * idempotency receipts. They never keep credential bytes: `secret_ref` is an
 * opaque handle into the private credential store.
 */

import type { DatabaseSync } from 'node:sqlite';

export const PROVIDER_CONNECTION_TABLES = [
  'ocean_provider_connections',
  'ocean_provider_receipts',
] as const;

export function migrateProviderConnections(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ocean_provider_connections (
      provider TEXT PRIMARY KEY,
      model TEXT,
      secret_ref TEXT,
      intent TEXT NOT NULL CHECK(intent IN ('active','disconnected','pending')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      request_id TEXT,
      binding TEXT,
      last_check TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ocean_provider_receipts (
      request_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      binding TEXT NOT NULL,
      result TEXT NOT NULL
    ) STRICT;
  `);
}
