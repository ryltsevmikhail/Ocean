import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  validProfileBackupManifest,
  type ProfileBackupManifest,
  type RestoredSnapshotState,
} from '@runnets/domain';
import { profileHash } from './profile-backup-output.js';
import { privateAssetDirectory } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { checkProfileArchiveFile } from './profile-archive-context.js';
import { verifyProfileAssetArchive, withProfileArchive } from './profile-backup-verify.js';
import {
  profileBackupDatabaseIdentity,
  verifyProfileBackupEnvelope,
} from './profile-backup-envelope.js';
import { deriveLineagePartition } from './profile-lineage-partition.js';
import type { ProfileBackupAssetCatalog } from './profile-backup-types.js';
export type ProfileSnapshotReader = (path: string) => RestoredSnapshotState;
export interface ProfileSnapshotGraph {
  manifest: Extract<ProfileBackupManifest, { format: 2 }>;
  snapshot: RestoredSnapshotState;
  catalog: ProfileBackupAssetCatalog;
  assets: string;
  depth: number;
  parent: ProfileSnapshotGraph | null;
}
const same = (a: unknown, b: unknown) => profileHash(a) === profileHash(b);
function manifestAt(path: string) {
  const fd = privateAssetDirectory(path);
  try {
    const m: unknown = JSON.parse(
      readDesktopArchiveFile(fd, 'snapshot.json', 33554432).toString('utf8'),
    );
    if (!validProfileBackupManifest(m) || m.format !== 2) throw Error('invalid_profile_lineage');
    return m;
  } finally {
    fs.closeSync(fd);
  }
}
export function verifySnapshotGraph(
  parts: { database: string; assets: string; lineage: string },
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
  read: ProfileSnapshotReader,
  ancestors: readonly string[] = [],
  incomplete = false,
): ProfileSnapshotGraph {
  const id = profileHash(manifest);
  if (ancestors.length >= 8 || ancestors.includes(id)) throw Error('profile_lineage_limit');
  const database = profileBackupDatabaseIdentity(parts.database);
  if (database.sha256 !== manifest.sha256 || database.bytes !== manifest.bytes)
    throw Error('invalid_profile_lineage');
  const fd = fs.openSync(
    parts.database,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let snapshot: RestoredSnapshotState;
  try {
    checkProfileArchiveFile(fd);
    snapshot = read('/proc/self/fd/' + fd);
    checkProfileArchiveFile(fd);
  } finally {
    fs.closeSync(fd);
  }
  const { catalog } = verifyProfileAssetArchive(
    parts.assets,
    manifest.assets,
    incomplete && fs.existsSync(join(parts.assets, '.incomplete')),
  );
  const lineage = manifest.lineage;
  let parent: ProfileSnapshotGraph | null = null;
  if (!lineage) {
    if (
      snapshot.restoration.origin ||
      snapshot.restoration.records.length ||
      !same(snapshot.coding, catalog.inventory) ||
      !same(snapshot.desktop, catalog.desktopInventory)
    )
      throw Error('invalid_profile_lineage');
  } else {
    parent = withProfileArchive(join(parts.lineage, 'parent'), () => {
      const root = join(parts.lineage, 'parent'),
        previous = manifestAt(root);
      return verifySnapshotGraph(
        {
          database: join(root, 'runtime.sqlite'),
          assets: join(root, 'assets'),
          lineage: join(root, 'lineage'),
        },
        previous,
        read,
        [...ancestors, id],
      );
    });
    if (
      profileHash(parent.manifest) !== lineage.parentSnapshotId ||
      !same(snapshot.restoration.origin?.manifest, parent.manifest) ||
      snapshot.restoration.origin?.snapshotId !== lineage.parentSnapshotId ||
      snapshot.coding.hash !== lineage.codingInventory ||
      profileHash(snapshot.desktop) !== lineage.desktopInventory ||
      profileHash(snapshot.restoration) !== lineage.recordsHash
    )
      throw Error('invalid_profile_lineage');
    const partition = deriveLineagePartition(
      snapshot.coding,
      snapshot.desktop,
      snapshot.restoration,
      parent.snapshot,
    );
    if (
      !same(partition.liveCoding, catalog.inventory) ||
      !same(partition.liveDesktop, catalog.desktopInventory) ||
      !same(partition.tasks, lineage.tasks) ||
      partition.desktopSource !== lineage.desktopSource ||
      lineage.intents.length !== partition.records.length
    )
      throw Error('invalid_profile_lineage');
    for (const [index, record] of partition.records.entries()) {
      const intent = lineage.intents[index];
      if (
        !intent ||
        intent.requestId !== record.requestId ||
        intent.state !== record.state ||
        intent.recordHash !== profileHash(record) ||
        !same(
          record.preview.originalTask,
          parent.snapshot.tasks.find((t) => t.id === record.preview.originalTask.id) ?? null,
        )
      )
        throw Error('invalid_profile_lineage');
      for (const output of intent.outputs) {
        if (
          (!record.worktreeLease && output.presence !== 'absent') ||
          (!record.preview.plan.desktop &&
            output.kind === 'desktop' &&
            output.presence !== 'absent') ||
          (record.state === 'ready' &&
            (output.kind !== 'desktop' || record.preview.plan.desktop) &&
            output.presence !== 'captured')
        )
          throw Error('invalid_profile_lineage');
      }
    }
  }
  return { manifest, snapshot, catalog, assets: parts.assets, depth: ancestors.length + 1, parent };
}
/** Full independent byte/schema/SQLite-reference verification, with no old path lookup. */
export function verifyProfileLineageGraph(
  directory: string,
  read: ProfileSnapshotReader,
): ProfileSnapshotGraph {
  let graph: ProfileSnapshotGraph | undefined;
  verifyProfileBackupEnvelope(directory, (manifest) => {
    graph = verifySnapshotGraph(
      {
        database: join(directory, 'runtime.sqlite'),
        assets: join(directory, 'assets'),
        lineage: join(directory, 'lineage'),
      },
      manifest,
      read,
    );
  });
  if (!graph) throw Error('invalid_profile_lineage');
  return graph;
}
export function profileTaskSource(
  graph: ProfileSnapshotGraph,
  taskId: string,
): ProfileSnapshotGraph {
  const source = graph.manifest.lineage?.tasks.find((t) => t.taskId === taskId)?.source;
  if (source === 'parent') {
    if (!graph.parent) throw Error('invalid_profile_lineage');
    return profileTaskSource(graph.parent, taskId);
  }
  if (!graph.catalog.inventory.tasks.some((t) => t.id === taskId))
    throw Error('invalid_profile_lineage');
  return graph;
}
