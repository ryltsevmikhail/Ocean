import type { DatabaseSync } from 'node:sqlite';

/** Owner-local publication evidence. No address, capability, PID or execution authority is stored. */
export function openEndpointProof(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_endpoint_v1 (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL CHECK(length(digest)=64)
  ) STRICT`);
  return {
    current(): string | null {
      const row = db.prepare('SELECT digest FROM local_endpoint_v1 WHERE singleton=1').get();
      return row ? String(row['digest']) : null;
    },
    publish(digest: string): void {
      db.prepare('INSERT INTO local_endpoint_v1 VALUES (1,?)').run(digest);
    },
    retire(digest: string): void {
      if (
        db.prepare('DELETE FROM local_endpoint_v1 WHERE singleton=1 AND digest=?').run(digest)
          .changes !== 1
      )
        throw Error('endpoint_changed');
    },
  };
}
export type EndpointProof = ReturnType<typeof openEndpointProof>;
