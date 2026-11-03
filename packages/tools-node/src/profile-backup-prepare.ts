import { prepareProfileGit } from './profile-backup-git-plan.js';
import type { ProfileBackupSource } from './profile-backup-types.js';
import {
  ProfileBackupSession,
  profileBackupSession,
  type ProfileBackupLimits,
} from './profile-backup-session.js';
import { prepareProfileBackupSources } from './profile-backup-plan.js';
export interface PreparedProfileBackup {
  /** Releases the original source witnesses, including on pre-copy failure. */
  close(): void;
}
interface PreparedState {
  source: ProfileBackupSource;
  session: ProfileBackupSession;
  destination: string;
  consumed: boolean;
  closed: boolean;
}
const prepared = new WeakMap<PreparedProfileBackup, PreparedState>();
/** Must run while the host holds ownership, before creating any destination entry. */
export function prepareProfileBackupAssets(
  input: ProfileBackupSource,
  destination: string,
  limits?: Partial<ProfileBackupLimits>,
): PreparedProfileBackup {
  const source = structuredClone(input),
    session = new ProfileBackupSession(limits);
  const state: PreparedState = { source, session, destination, consumed: false, closed: false };
  try {
    profileBackupSession.run(session, () => {
      session.budget.charge('database', {
        stored: source.databaseBytes,
        logical: source.databaseBytes,
        entries: 1,
      });
      prepareProfileBackupSources(
        session,
        source.inventory,
        source.desktop,
        source.profile,
        source.managed,
        destination,
      );
      prepareProfileGit(session, source.inventory.worktrees, source.managed);
    });
    const handle = {
      close: () => {
        if (!state.closed) {
          state.closed = true;
          session.close();
        }
      },
    };
    prepared.set(handle, state);
    return handle;
  } catch (error) {
    session.close();
    throw error;
  }
}
export function consumePreparedProfileBackup(
  input: ProfileBackupSource | PreparedProfileBackup,
  destination: string,
  limits?: Partial<ProfileBackupLimits>,
) {
  const handle =
    'inventory' in input ? prepareProfileBackupAssets(input, destination, limits) : input;
  const state = prepared.get(handle);
  if (!state || state.closed || state.consumed || state.destination !== destination)
    throw Error('invalid_profile_backup_preparation');
  state.consumed = true;
  return { source: state.source, session: state.session, close: () => handle.close() };
}
