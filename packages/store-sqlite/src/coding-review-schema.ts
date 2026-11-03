import type { DatabaseSync } from 'node:sqlite';
export const CODING_REVIEW_TABLES = [
  'ocean_coding_test_evidence',
  'ocean_coding_review_requests',
  'ocean_coding_review_verdicts',
] as const;
export function migrateCodingReviews(db: DatabaseSync): void {
  db.exec(`
 CREATE TABLE ocean_coding_test_evidence(
 id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,payload TEXT NOT NULL
 ) STRICT;
 CREATE TABLE ocean_coding_review_requests(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
 CREATE TABLE ocean_coding_review_verdicts(
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES ocean_coding_review_requests(id),payload TEXT NOT NULL
 ) STRICT;
 `);
}
