import type { DatabaseSync } from 'node:sqlite';
import { modelConnectionRecord } from '@runnets/application';
/** Schema 21 materializes nullable qualification in the existing authority row only. */
export function migrateModelQualifications(db: DatabaseSync): void {
  const update = db.prepare('UPDATE ocean_model_connections SET payload=? WHERE connection_id=?');
  for (const row of db.prepare('SELECT connection_id,payload FROM ocean_model_connections').all()) {
    const record = modelConnectionRecord(JSON.parse(String(row['payload'])) as unknown);
    if (record.connectionId !== row['connection_id']) throw Error('connection_unverified');
    update.run(JSON.stringify(record), record.connectionId);
  }
  // Frozen historic receipts retain their original bytes; the decoder supplies null.
}
