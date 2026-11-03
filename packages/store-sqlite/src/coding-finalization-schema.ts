import type { DatabaseSync } from 'node:sqlite';
export const CODING_FINALIZATION_TABLES = ['ocean_coding_finalizations'] as const;
/**
 * Schema 14 keeps every coding row while widening the disabled-status CHECK and
 * adds the durable finalization record. Nothing is released by migration.
 */
export function migrateCodingFinalizations(db: DatabaseSync): void {
  const current = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ocean_coding_tasks'")
    .get()?.['sql'];
  if (typeof current !== 'string')
    throw Error('database schema is missing table ocean_coding_tasks');
  if (!current.includes("'finalizing'")) {
    db.exec(`
  CREATE TABLE ocean_coding_tasks_v14(
   id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_root TEXT NOT NULL,
   owner_room_id TEXT NOT NULL,dev_bot_id TEXT NOT NULL,review_room_id TEXT NOT NULL,review_bot_id TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN ('reserved','cancelled','finalizing','finalized')),
   policy_version INTEGER NOT NULL CHECK(policy_version=1),payload TEXT NOT NULL,
   UNIQUE(workspace_id,id),
   FOREIGN KEY(workspace_id) REFERENCES ocean_workspace(id),
   FOREIGN KEY(owner_room_id,dev_bot_id) REFERENCES ocean_members(room_id,bot_id),
   FOREIGN KEY(review_room_id,review_bot_id) REFERENCES ocean_members(room_id,bot_id),
   CHECK(dev_bot_id!=review_bot_id)
  ) STRICT;
  INSERT INTO ocean_coding_tasks_v14 SELECT * FROM ocean_coding_tasks;
  DROP TABLE ocean_coding_tasks;
  ALTER TABLE ocean_coding_tasks_v14 RENAME TO ocean_coding_tasks;
  CREATE UNIQUE INDEX ocean_coding_project_hold ON ocean_coding_tasks(project_root) WHERE status='reserved';
  `);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ocean_coding_finalizations(
   request_id TEXT PRIMARY KEY,
   task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id),
   project_root TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('preview','finalizing','finalized','uncertain','refused')),
   revision INTEGER NOT NULL CHECK(revision>=1),
   binding_digest TEXT NOT NULL,
   payload TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS ocean_coding_finalization_hold ON ocean_coding_finalizations(task_id)
   WHERE state IN ('preview','finalizing','finalized','uncertain');
  `);
}
