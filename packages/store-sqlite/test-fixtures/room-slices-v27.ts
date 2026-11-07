import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export const bytes = readFileSync(new URL('./room-slices-v27.json', import.meta.url));
export const fixture = JSON.parse(bytes.toString()) as {
  base: string;
  schema: { type: string; name: string; sql: string }[];
  rows: Record<string, Record<string, SQLInputValue>[]>;
};
export function seed(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN');
  for (const s of fixture.schema.filter((s) => s.type === 'table')) db.exec(s.sql);
  for (const [table, rows] of Object.entries(fixture.rows))
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    }
  for (const s of fixture.schema.filter((s) => s.type !== 'table')) db.exec(s.sql);
  db.exec('COMMIT');
}
