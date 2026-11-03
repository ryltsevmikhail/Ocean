import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';
export function userTables(db: DatabaseSync): ReadonlySet<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return new Set(rows.map((row) => readText(row, 'name')));
}
