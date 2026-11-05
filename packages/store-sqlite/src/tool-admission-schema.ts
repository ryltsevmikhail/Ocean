import type { DatabaseSync } from 'node:sqlite';
export const admissionColumn =
  'admission TEXT CHECK(admission IS NULL OR (json_valid(admission) AND length(CAST(admission AS BLOB)) <= 2097152))';
export function migrateToolAdmission(db: DatabaseSync, previousVersion: number): void {
  if (
    db
      .prepare('PRAGMA table_info(tool_invocations_v2)')
      .all()
      .some((r) => r['name'] === 'admission')
  )
    return;
  if (previousVersion >= 25)
    throw Error('database schema is missing tool admission evidence column');
  db.exec('ALTER TABLE tool_invocations_v2 ADD COLUMN ' + admissionColumn);
}
