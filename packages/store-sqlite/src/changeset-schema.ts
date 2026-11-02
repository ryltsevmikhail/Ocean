import type { DatabaseSync } from 'node:sqlite';
export const CHANGESET_TABLES = [
  'ocean_worktrees',
  'ocean_changesets',
  'ocean_capture_receipts',
] as const;
export function migrateChangesets(db: DatabaseSync): void {
  db.exec(`
 CREATE TABLE ocean_worktrees(
  task_id TEXT PRIMARY KEY REFERENCES ocean_coding_tasks(id),root TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('preparing','ready','uncertain')),payload TEXT NOT NULL
 ) STRICT;
 CREATE TABLE ocean_changesets(
  hash TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id),payload TEXT NOT NULL
 ) STRICT;
 CREATE TABLE ocean_capture_receipts(
  request_id TEXT PRIMARY KEY,binding TEXT NOT NULL,hash TEXT NOT NULL REFERENCES ocean_changesets(hash)
 ) STRICT;
 `);
}
