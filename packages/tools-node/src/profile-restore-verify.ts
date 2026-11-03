import * as fs from 'node:fs';
import { join } from 'node:path';
import { validProfileBackupManifest, type ProfileBackupManifest } from '@runnets/domain';
import { privateAssetDirectory, assetNames } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { profileHash } from './profile-backup-output.js';
import { withProfileArchive, verifyProfileAssetArchive } from './profile-backup-verify.js';
import { profileBackupDatabaseIdentity } from './profile-backup-envelope.js';
import { desktopRootIdentity } from './desktop-assets.js';
import { checkProfileArchiveFile } from './profile-archive-context.js';
import {
  verifySnapshotGraph,
  type ProfileSnapshotGraph,
  type ProfileSnapshotReader,
} from './profile-lineage-graph.js';
import { verifyLineageArchives } from './profile-lineage-verify.js';

function lineageParts(
  profile: string,
  expected: Extract<ProfileBackupManifest, { format: 2 }>,
  readSnapshot: ProfileSnapshotReader,
): ProfileSnapshotGraph {
  const origin = join(profile, 'restore-origin'),
    lineage = join(profile, 'restore-lineage');
  if (!expected.lineage) throw Error('invalid_restore_origin');
  if (!fs.lstatSync(lineage, { throwIfNoEntry: false })) throw Error('invalid_restore_origin');
  // Structural parent/intents verification precedes any partition or task lookup.
  verifyLineageArchives(lineage, expected.lineage);
  return verifySnapshotGraph(
    { database: join(origin, 'runtime.sqlite'), assets: join(profile, 'assets/evidence'), lineage },
    expected,
    readSnapshot,
  );
}
/** Bounded runtime admission: the published guard must match this exact baseline. */
export function verifyRestoredProfileOrigin<T = undefined>(
  profile: string,
  expected: Extract<ProfileBackupManifest, { format: 2 }>,
  readSnapshot?: (descriptorPath: string) => T,
) {
  if (!validProfileBackupManifest(expected) || expected.format !== 2)
    throw Error('invalid_restore_origin');
  if (fs.lstatSync(join(profile, '.incomplete'), { throwIfNoEntry: false }))
    throw Error('recovery_required');
  const root = privateAssetDirectory(profile);
  try {
    const guard = JSON.parse(
      readDesktopArchiveFile(root, 'restore-guard.json', 4096).toString('utf8'),
    ) as {
      state?: unknown;
      format?: unknown;
      sha256?: unknown;
      snapshotAt?: unknown;
    };
    if (
      guard.state !== 'ready' ||
      guard.format !== 2 ||
      guard.sha256 !== expected.sha256 ||
      guard.snapshotAt !== expected.createdAt
    )
      throw Error('invalid_restore_origin');
  } finally {
    fs.closeSync(root);
  }
  return verifyRestoredProfileBaseline(profile, expected, readSnapshot);
}
/** Baseline bytes may be re-verified while the public destination is still incomplete. */
export function verifyRestoredProfileBaseline<T = undefined>(
  profile: string,
  expected: Extract<ProfileBackupManifest, { format: 2 }>,
  readSnapshot?: (descriptorPath: string) => T,
) {
  if (!validProfileBackupManifest(expected) || expected.format !== 2)
    throw Error('invalid_restore_origin');
  const witness = desktopRootIdentity(profile);
  const origin = join(profile, 'restore-origin'),
    assets = join(profile, 'assets/evidence');
  const lineage = join(profile, 'restore-lineage');
  return withProfileArchive(origin, (original) => {
    const fd = privateAssetDirectory(origin);
    try {
      if (assetNames(fd, 4).join() !== 'runtime.sqlite,snapshot.json')
        throw Error('invalid_restore_origin');
      const manifest: unknown = JSON.parse(
        readDesktopArchiveFile(fd, 'snapshot.json', 33554432).toString('utf8'),
      );
      if (!validProfileBackupManifest(manifest) || profileHash(manifest) !== profileHash(expected))
        throw Error('invalid_restore_origin');
    } finally {
      fs.closeSync(fd);
    }
    const database = profileBackupDatabaseIdentity(join(origin, 'runtime.sqlite'));
    if (database.bytes !== expected.bytes || database.sha256 !== expected.sha256)
      throw Error('invalid_restore_origin');
    if (!expected.lineage && fs.lstatSync(lineage, { throwIfNoEntry: false }))
      throw Error('invalid_restore_origin');
    if (expected.lineage && !readSnapshot) throw Error('invalid_restore_origin');
    let graph: ProfileSnapshotGraph | undefined, snapshot: T | undefined;
    const catalog =
      expected.lineage || readSnapshot
        ? (graph = expected.lineage
            ? lineageParts(profile, expected, readSnapshot as ProfileSnapshotReader)
            : verifySnapshotGraph(
                { database: join(origin, 'runtime.sqlite'), assets, lineage },
                expected,
                readSnapshot as ProfileSnapshotReader,
              )).catalog
        : verifyProfileAssetArchive(assets, expected.assets).catalog;
    if (graph) snapshot = graph.snapshot as T;
    else {
      const frozen = fs.openSync(
        join(origin, 'runtime.sqlite'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        checkProfileArchiveFile(frozen);
      } finally {
        fs.closeSync(frozen);
      }
    }
    if (desktopRootIdentity(profile) !== witness) throw Error('stale_coding_asset');
    return {
      snapshotId: profileHash(expected),
      profileWitness: witness,
      originWitness: original.sourceStateHash,
      catalog,
      snapshot,
      graph,
    };
  });
}
