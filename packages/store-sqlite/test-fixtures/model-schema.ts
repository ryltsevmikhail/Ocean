import { omitRoomTaskSchema } from './room-task-v26.js';
import type { DatabaseSync } from 'node:sqlite';

/** Recreate a pre-v20 fixture without later room policies; production migration never tolerates leftover v20 tables. */
export function omitModelConnectionSchema(db: DatabaseSync): void {
  omitRoomTaskSchema(db);
  db.exec(`DROP TABLE IF EXISTS ocean_room_model_policies;
    DROP TABLE IF EXISTS ocean_bot_model_bindings;
    DROP TABLE IF EXISTS ocean_model_connection_receipts;
    DROP TABLE IF EXISTS ocean_model_connections`);
}
