/**
 * Typed readers for SQLite rows.
 *
 * `node:sqlite` hands back untyped column objects, so every value read from a
 * row passes through these guards before it enters a typed structure. A failed
 * guard means the database contents do not match the schema this adapter owns.
 */

/** A row returned by `StatementSync.get` or `StatementSync.all`. */
export type SqliteRow = Readonly<Record<string, unknown>>;

/** Read a required TEXT column. */
export function readText(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`SQLite column ${column} must be TEXT`);
  }
  return value;
}

/** Read a required INTEGER column. */
export function readInteger(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`SQLite column ${column} must be an INTEGER`);
  }
  return value;
}

/** Read a nullable TEXT column. */
export function readNullableText(row: SqliteRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`SQLite column ${column} must be TEXT or NULL`);
  }
  return value;
}
