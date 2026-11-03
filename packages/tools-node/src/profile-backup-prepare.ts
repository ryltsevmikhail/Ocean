import { prepareProfileGit } from './profile-backup-git-plan.js';
import type { ProfileBackupSource } from './profile-backup-types.js';
import {
  ProfileBackupSession,
  profileBackupSession,
  type ProfileBackupLimits,
} from './profile-backup-session.js';
import { prepareProfileBackupSources } from './profile-backup-plan.js';
import {
  prepareProfileLineage,
  type ProfileLineagePartition,
} from './profile-lineage-preparation.js';
export interface PreparedProfileBackup {
  /** Releases the original source witnesses, including on pre-copy failure. */
  close(): void;
}
interface PreparedState {
  source: ProfileBackupSource;
  session: ProfileBackupSession;
  destination: string;
  partition: ProfileLineagePartition;
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
  // An origin-bearing profile may hold an archived (old-profile) Desktop binding and
  // pre-rebind tasks that are NOT live sources. Only lineage partition can separate
  // frozen parent evidence from current live assets; without the frozen-snapshot
  // reader a caller must not archive such a profile at all.
  if (input.restoration?.origin && !input.readSnapshot) throw Error('restoration_lineage_required');
  const { readSnapshot, ...cloneable } = input;
  const source: ProfileBackupSource = {
    ...structuredClone(cloneable),
    ...(readSnapshot ? { readSnapshot } : {}),
  };
  const session = new ProfileBackupSession(limits);
  const state: PreparedState = {
    source,
    session,
    destination,
    partition: { inventory: source.inventory, desktop: source.desktop, lineage: null },
    consumed: false,
    closed: false,
  };
  try {
    profileBackupSession.run(session, () => {
      session.budget.charge('database', {
        stored: source.databaseBytes,
        logical: source.databaseBytes,
        entries: 1,
      });
      if (source.restoration && source.readSnapshot)
        state.partition = prepareProfileLineage(session, {
          profile: source.profile,
          inventory: source.inventory,
          desktop: source.desktop,
          restoration: source.restoration,
          readSnapshot: source.readSnapshot,
        });
      prepareProfileBackupSources(
        session,
        state.partition.inventory,
        state.partition.desktop,
        source.profile,
        source.managed,
        destination,
        {
          roots: source.inventory.tasks.map((task) => task.projectRoot),
          gitCommonDirs: source.inventory.worktrees.map((tree) => tree.gitCommonDir),
        },
      );
      prepareProfileGit(session, state.partition.inventory.worktrees, source.managed);
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
  return {
    source: state.source,
    session: state.session,
    partition: state.partition,
    close: () => handle.close(),
  };
}
