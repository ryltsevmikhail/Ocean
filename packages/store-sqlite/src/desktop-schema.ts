import type { DatabaseSync } from 'node:sqlite';
export function migrateDesktopAssets(db: DatabaseSync): void {
  db.exec(`CREATE TABLE ocean_desktop_operations(id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('started','completed')),result TEXT) STRICT;
    CREATE TABLE ocean_desktop_uploads(id TEXT PRIMARY KEY,room TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL) STRICT;
    CREATE TABLE ocean_desktop_adopted(message_id TEXT PRIMARY KEY,room TEXT NOT NULL,request_id TEXT NOT NULL,body TEXT NOT NULL) STRICT;`);
}
