import type { DatabaseSync } from 'node:sqlite';
export const CODING_APPLY_TABLES = ['ocean_coding_applications'] as const;
export function migrateCodingApplications(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE ocean_coding_applications(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT',
  );
}
