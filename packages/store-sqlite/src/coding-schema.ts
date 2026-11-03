import type { DatabaseSync } from 'node:sqlite';
export const CODING_TABLES = ['ocean_coding_tasks', 'ocean_coding_receipts'] as const;
/** Add reserved task policy without granting any existing bot executable authority. */
export function migrateCoding(db: DatabaseSync): void {
  db.exec(`
 CREATE TABLE ocean_coding_tasks(
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
 CREATE UNIQUE INDEX ocean_coding_project_hold ON ocean_coding_tasks(project_root) WHERE status='reserved';
 CREATE TABLE ocean_coding_receipts(
  request_id TEXT PRIMARY KEY,binding TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES ocean_coding_tasks(id)
 ) STRICT;
 `);
}
