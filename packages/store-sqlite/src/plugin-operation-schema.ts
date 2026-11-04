/**
 * Durable plugin operation journal schema (migration 18).
 *
 * One row per admitted plugin invocation. The immutable target binding
 * (plugin, connection, generation, endpoint), the exact tool and repository,
 * the schema and argument digests and a bounded secret-free argument copy are
 * written in the same transaction as the tool-journal claim. No credential
 * value and no raw provider payload is ever stored here.
 */

import type { DatabaseSync } from 'node:sqlite';

export const PLUGIN_OPERATION_TABLES = ['ocean_plugin_operations'] as const;

export function migratePluginOperations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ocean_plugin_operations (
      id TEXT PRIMARY KEY,
      task_run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL CHECK(connection_generation >= 1),
      endpoint TEXT NOT NULL,
      tool TEXT NOT NULL,
      repository TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      arguments_digest TEXT NOT NULL,
      arguments TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN
        ('started','observed','failed','not_started','uncertain','acknowledged')),
      outcome_code TEXT,
      detail TEXT,
      result_summary TEXT,
      result_bytes INTEGER,
      truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      settled_at TEXT,
      acknowledged_at TEXT,
      acknowledged_reason TEXT,
      CHECK((state = 'started') = (settled_at IS NULL)),
      CHECK((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ocean_plugin_operations_scope
      ON ocean_plugin_operations(workspace_id, room_id, bot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ocean_plugin_operations_state
      ON ocean_plugin_operations(state, created_at DESC);
    CREATE INDEX IF NOT EXISTS ocean_plugin_operations_connection
      ON ocean_plugin_operations(connection_id, connection_generation);
  `);
}
