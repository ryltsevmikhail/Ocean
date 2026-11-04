import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRestorationAuthority } from '@runnets/store-sqlite';
import {
  restoredRuntimeAdmission,
  restoreMarkerPresent,
  runtimeIncomplete,
} from '../runtime-restoration.js';
export interface RestorationPaths {
  readonly profile: string;
}
/** Ordinary startup requires a verified ready epoch; inert quarantines never start. */
export function createRestorationCheck(paths: RestorationPaths, restore: boolean): () => void {
  return () => {
    if (runtimeIncomplete(paths.profile)) throw Error('recovery_required');
    if (restore || !restoreMarkerPresent(paths.profile)) return;
    const database = join(paths.profile, 'runtime.sqlite');
    if (!existsSync(database)) throw Error('restore_restricted');
    const { origin, active } = readRestorationAuthority(database);
    if (!origin || !active) throw Error('restore_restricted');
    restoredRuntimeAdmission(paths.profile, origin, undefined, active);
  };
}
const MAINTENANCE_READS = new Set(
  `rooms.list rooms.members history.list runs.list runs.events runs.result runs.get
  receipts.get observe bots.list coding.show coding.diff coding.pending coding.panel
  decisions.list decisions.get decisions.preview decisions.resolve provider.status
  broadcasts.get broadcasts.list`.split(/\s+/),
);
/** A restore-mode maintenance host serves reads only; every mutation stays refused. */
export function maintenanceRead(method: string): boolean {
  return MAINTENANCE_READS.has(method);
}
