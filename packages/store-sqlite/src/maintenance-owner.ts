import type { DatabaseSync } from 'node:sqlite';
import { verifiedOwnerDead } from './owner-evidence.js';
export function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
export function ownerBusy(db: DatabaseSync): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_owner_v1'").get()) return false;
  const owner = db.prepare('SELECT owner,pid FROM runtime_owner_v1 WHERE singleton=1').get();
  if (!owner) return false;
  return !verifiedOwnerDead(owner, ownerAlive);
}
