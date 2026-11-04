import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProfileRebindRecord, RestoreOrigin } from '@runnets/domain';
import { readProfileRestoreSnapshot } from '@runnets/store-sqlite';
import { verifyRestoredProfileOrigin, desktopBindingMatches } from '@runnets/tools-node';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Ready is durable authority, not an instruction to replay materialization or archived operations. */
export function verifyRuntimeEpoch(
  profile: string,
  origin: RestoreOrigin,
  active: ProfileRebindRecord,
): void {
  const { preview: p, result } = active;
  if (
    active.state !== 'ready' ||
    !result ||
    hash(p.origin) !== hash(origin) ||
    p.ownerId !== origin.profileId + ':' + p.epochId ||
    p.plan.assetDirectory !== join(profile, 'rebind-' + p.epochId) ||
    p.plan.managedDirectory !== join(p.plan.assetDirectory, 'materialized/tree') ||
    p.plan.worktree.root !==
      join(p.plan.managedDirectory, hash([p.ownerId, p.selection.projectRoot, p.successorTaskId]))
  )
    throw Error('invalid_execution_epoch');
  const verified = verifyRestoredProfileOrigin(
    profile,
    origin.manifest,
    readProfileRestoreSnapshot,
  );
  // A lineage origin stores every frozen task; only the verified live partition is cataloged.
  if (
    !verified.snapshot ||
    (!origin.manifest.lineage &&
      (hash(verified.snapshot.coding) !== hash(verified.catalog.inventory) ||
        hash(verified.snapshot.desktop) !== hash(verified.catalog.desktopInventory))) ||
    hash(verified.snapshot.tasks.find((t) => t.id === p.originalTask.id) ?? null) !==
      hash(p.originalTask)
  )
    throw Error('invalid_restore_origin');
  // New mutable work may change content. Preserve root/binding identity rather than the initial tree hash.
  if (
    fs.realpathSync(result.worktree.root) !== result.worktree.root ||
    fs.realpathSync(p.plan.managedDirectory) !== p.plan.managedDirectory
  )
    throw Error('invalid_execution_epoch');
  if (
    result.desktop &&
    (result.desktop.profileId !== origin.profileId ||
      result.desktop.root !== p.plan.desktop?.root ||
      !desktopBindingMatches(result.desktop))
  )
    throw Error('invalid_execution_epoch');
}
