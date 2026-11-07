import type { DatabaseSync } from 'node:sqlite';
/** Existing allow behavior becomes explicit authority; current-schema reads never backfill. */
export function migrateRoomModelPolicies(db: DatabaseSync): void {
  db.exec(`CREATE TABLE ocean_room_model_policies(
    room_id TEXT PRIMARY KEY REFERENCES ocean_rooms(id),
    cloud_transfer TEXT NOT NULL CHECK(cloud_transfer IN ('allow','deny')),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  INSERT INTO ocean_room_model_policies SELECT id,'allow',1 FROM ocean_rooms;`);
}
