import type { DatabaseSync } from 'node:sqlite';
export const CODING_APPROVAL_TABLES = [
  'ocean_coding_approvals',
  'ocean_coding_approval_claims',
] as const;
export function migrateCodingApprovals(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE ocean_coding_approvals(
      id TEXT PRIMARY KEY,payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE ocean_coding_approval_claims(
      invocation_key TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL UNIQUE REFERENCES ocean_coding_approvals(id)
    ) STRICT;
  `);
}
