import type { DatabaseSync } from 'node:sqlite';
import { unconfiguredModelConnection } from '@runnets/application';
import { canonicalProviderRecord, legacyProviderRow } from './legacy-provider-rows.js';
import { modelConnectionRecord } from './model-connection-record.js';

export const MODEL_CONNECTION_TABLES = [
  'ocean_model_connections',
  'ocean_bot_model_bindings',
  'ocean_model_connection_receipts',
] as const;

/** Runs only inside schema initialization's transaction; never reads private keys or environment. */
export function migrateModelConnections(db: DatabaseSync): void {
  db.exec(`CREATE TABLE ocean_model_connections (
      connection_id TEXT PRIMARY KEY, payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE ocean_bot_model_bindings (
      bot_id TEXT PRIMARY KEY REFERENCES ocean_bots(id),
      connection_id TEXT NOT NULL REFERENCES ocean_model_connections(connection_id),
      model_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE ocean_model_connection_receipts (
      request_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES ocean_model_connections(connection_id),
      binding TEXT NOT NULL, result TEXT NOT NULL
    ) STRICT;`);
  const insert = db.prepare('INSERT INTO ocean_model_connections VALUES(?,?)');
  for (const row of db.prepare('SELECT * FROM ocean_provider_connections').all()) {
    const record = modelConnectionRecord(canonicalProviderRecord(legacyProviderRow(row)));
    insert.run(record.connectionId, JSON.stringify(record));
  }
  // DeepSeek's existing environment seam remains available even in profiles with no bots yet.
  const providers = new Set([
    'deepseek',
    ...db
      .prepare('SELECT provider FROM ocean_bots')
      .all()
      .map((row) => String(row['provider'])),
  ]);
  for (const provider of providers) {
    const record = unconfiguredModelConnection(provider);
    db.prepare('INSERT OR IGNORE INTO ocean_model_connections VALUES(?,?)').run(
      record.connectionId,
      JSON.stringify(record),
    );
  }
  db.exec(`INSERT INTO ocean_bot_model_bindings(bot_id,connection_id,model_id)
    SELECT id,'legacy:' || provider,model FROM ocean_bots`);
}
