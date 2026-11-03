import type {
  CodingBackupInventory,
  DesktopAssetInventory,
  RestorationBackupState,
  RestoredSnapshotState,
} from '@runnets/domain';
import { profileHash } from './profile-backup-output.js';
const same = (a: unknown, b: unknown) => profileHash(a) === profileHash(b);
const fail = (): never => {
  throw Error('invalid_profile_lineage');
};
function subset(inventory: CodingBackupInventory, ids: ReadonlySet<string>): CodingBackupInventory {
  const body = {
    format: 1 as const,
    tasks: inventory.tasks.filter((t) => ids.has(t.id)),
    worktrees: inventory.worktrees.filter((t) => ids.has(t.taskId)),
    changesets: inventory.changesets.filter((t) => ids.has(t.taskId)),
    applications: inventory.applications.filter((t) => ids.has(t.taskId)),
  };
  return { ...body, hash: profileHash(body) };
}
function retained<T>(current: readonly T[], parent: readonly T[], key: (value: T) => string) {
  const values = new Map(current.map((v) => [key(v), v]));
  if (values.size !== current.length || parent.some((v) => !same(values.get(key(v)) ?? null, v)))
    fail();
}
/** Exact storage provenance. No selector can grant capabilities or exclude a pending effect. */
export function deriveLineagePartition(
  coding: CodingBackupInventory,
  desktop: DesktopAssetInventory,
  state: RestorationBackupState,
  parent: RestoredSnapshotState,
) {
  const origin = state.origin;
  if (!origin || !state.origins.some((o) => same(o, origin))) return fail();
  retained(state.records, parent.restoration.records, (r) => r.requestId);
  retained(state.observations, parent.restoration.observations, (r) => r.id);
  retained(state.origins, parent.restoration.origins, (r) => profileHash(r));
  retained(state.retired, parent.restoration.retired, (r) => profileHash(r));
  const records = state.records.filter((r) => same(r.preview.origin, origin));
  if (
    state.records.some(
      (r) => !records.includes(r) && !parent.restoration.records.some((p) => same(p, r)),
    )
  )
    return fail();
  const active =
    state.activeRequestId === null
      ? null
      : records.find((r) => r.requestId === state.activeRequestId);
  if (state.activeRequestId !== null && (!active || active.state !== 'ready' || !active.result))
    return fail();
  const archived = new Set(parent.coding.tasks.map((t) => t.id));
  if (!same(subset(coding, archived), parent.coding)) return fail();
  const liveIds = new Set(coding.tasks.filter((t) => !archived.has(t.id)).map((t) => t.id));
  if (
    coding.tasks.some((t) => liveIds.has(t.id) && (!active || t.ownerId !== active.preview.ownerId))
  )
    return fail();
  const liveCoding = subset(coding, liveIds);
  const desktopSource = active?.result?.desktop ? ('live' as const) : ('parent' as const);
  if (desktopSource === 'live' && !same(desktop.binding, active!.result!.desktop)) return fail();
  const withoutRooms = ({ rooms: _rooms, ...rest }: DesktopAssetInventory) => rest;
  if (desktopSource === 'parent' && !same(withoutRooms(desktop), withoutRooms(parent.desktop)))
    return fail();
  const liveDesktop: DesktopAssetInventory =
    desktopSource === 'live'
      ? desktop
      : {
          format: 1,
          binding: null,
          rooms: desktop.rooms,
          messages: [],
          operations: [],
          uploads: [],
        };
  return {
    liveCoding,
    liveDesktop,
    records,
    active: active ?? null,
    desktopSource,
    tasks: coding.tasks.map((t) => ({
      taskId: t.id,
      source: archived.has(t.id) ? ('parent' as const) : ('live' as const),
    })),
  };
}
