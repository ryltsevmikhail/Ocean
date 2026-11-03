import * as fs from 'node:fs';
import { join } from 'node:path';
import type {
  CodingAssetManifest,
  CodingBackupInventory,
  DesktopAssetInventory,
  ProfileBackupLineage,
  ProfileBackupManifest,
  RestorationBackupState,
} from '@runnets/domain';
import type { CodingAssetCapture } from './coding-asset-state.js';
import { assetNames, privateAssetDirectory } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { profileHash } from './profile-backup-output.js';
import { profileManifestCharge } from './profile-backup-accounting.js';
import type { ProfileBackupSession } from './profile-backup-session.js';
import { profileArchiveContext } from './profile-archive-context.js';
import { withProfileArchive } from './profile-backup-verify.js';
import { profileBackupDatabaseIdentity } from './profile-backup-envelope.js';
import {
  verifySnapshotGraph,
  type ProfileSnapshotGraph,
  type ProfileSnapshotReader,
} from './profile-lineage-graph.js';
import { deriveLineagePartition } from './profile-lineage-partition.js';
import { verifyLineageArchives } from './profile-lineage-verify.js';
import { inspectLineageIntent, type LineageIntentPlan } from './profile-lineage-intents.js';

export type {
  LineageIntentPlan,
  LineageOutputMode,
  LineageOutputPlan,
} from './profile-lineage-intents.js';
export {
  inspectLineageIntent,
  lineageIntentOutputs,
  requireLineageOutput,
} from './profile-lineage-intents.js';
export interface ProfileLineageParent {
  readonly manifest: Extract<ProfileBackupManifest, { format: 2 }>;
  readonly database: string;
  readonly assets: string;
  readonly lineage: string | null;
  readonly assetsCapture: CodingAssetCapture;
  readonly lineageCapture: CodingAssetCapture | null;
}
export interface PreparedProfileLineage {
  readonly parent: ProfileLineageParent;
  readonly intents: readonly LineageIntentPlan[];
  readonly lineage: ProfileBackupLineage;
}
export interface ProfileLineagePartition {
  readonly inventory: CodingBackupInventory;
  readonly desktop: DesktopAssetInventory;
  readonly lineage: PreparedProfileLineage | null;
}
export interface ProfileLineageInputs {
  readonly profile: string;
  readonly inventory: CodingBackupInventory;
  readonly desktop: DesktopAssetInventory;
  readonly restoration: RestorationBackupState;
  readonly readSnapshot: ProfileSnapshotReader;
}
function verifyOriginParts(
  profile: string,
  session: ProfileBackupSession,
  inputs: ProfileLineageInputs,
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
  assets: string,
  lineageDir: string,
): {
  graph: ProfileSnapshotGraph;
  assetsCapture: CodingAssetCapture;
  lineageCapture: CodingAssetCapture | null;
} {
  let assetsCapture: CodingAssetCapture | undefined,
    lineageCapture: CodingAssetCapture | null = null;
  const graph = profileArchiveContext.run({ budget: session.budget, roots: [] }, () => {
    assetsCapture = withProfileArchive(assets, (capture) => structuredClone(capture));
    if (manifest.lineage) {
      if (!fs.lstatSync(lineageDir, { throwIfNoEntry: false }))
        throw Error('invalid_restore_origin');
      lineageCapture = withProfileArchive(lineageDir, (capture) => structuredClone(capture));
      verifyLineageArchives(lineageDir, manifest.lineage);
    } else if (fs.lstatSync(lineageDir, { throwIfNoEntry: false }))
      throw Error('invalid_restore_origin');
    return verifySnapshotGraph(
      {
        database: join(profile, 'restore-origin/runtime.sqlite'),
        assets,
        lineage: lineageDir,
      },
      manifest,
      inputs.readSnapshot,
    );
  });
  if (!assetsCapture) throw Error('invalid_restore_origin');
  return { graph, assetsCapture, lineageCapture };
}
function chargeCopy(
  session: ProfileBackupSession,
  key: string,
  manifest: CodingAssetManifest,
  extra = 0,
): void {
  const charge = profileManifestCharge(manifest);
  session.budget.charge(key, { ...charge, metadata: charge.metadata + extra });
}
export function prepareProfileLineage(
  session: ProfileBackupSession,
  inputs: ProfileLineageInputs,
): ProfileLineagePartition {
  const origin = inputs.restoration.origin;
  if (!origin) return { inventory: inputs.inventory, desktop: inputs.desktop, lineage: null };
  const profile = inputs.profile,
    originDir = join(profile, 'restore-origin'),
    assets = join(profile, 'assets/evidence'),
    lineageDir = join(profile, 'restore-lineage');
  const fd = privateAssetDirectory(originDir);
  let manifest: unknown;
  try {
    if (assetNames(fd, 4).join() !== 'runtime.sqlite,snapshot.json')
      throw Error('invalid_restore_origin');
    manifest = JSON.parse(readDesktopArchiveFile(fd, 'snapshot.json', 33554432).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
  if (
    profileHash(manifest) !== origin.snapshotId ||
    JSON.stringify(manifest) !== JSON.stringify(origin.manifest)
  )
    throw Error('invalid_restore_origin');
  const database = profileBackupDatabaseIdentity(join(originDir, 'runtime.sqlite'));
  if (database.bytes !== origin.manifest.bytes || database.sha256 !== origin.manifest.sha256)
    throw Error('invalid_restore_origin');
  const parts = verifyOriginParts(profile, session, inputs, origin.manifest, assets, lineageDir);
  let chain = 1;
  for (let node: ProfileSnapshotGraph | null = parts.graph; node?.parent; node = node.parent)
    chain++;
  if (chain >= 8) throw Error('profile_lineage_limit');
  const partition = deriveLineagePartition(
    inputs.inventory,
    inputs.desktop,
    inputs.restoration,
    parts.graph.snapshot,
  );
  if (partition.tasks.length > 1000 || partition.records.length > 1000)
    throw Error('profile_lineage_limit');
  const intents = partition.records.map((record) => inspectLineageIntent(profile, record));
  for (const intent of intents)
    for (const output of intent.outputs) {
      if (output.capture)
        chargeCopy(
          session,
          'lineage-intent:' + intent.requestId + ':' + output.kind,
          output.capture.manifest,
          1024,
        );
      if (output.file)
        session.budget.charge(
          'lineage-intent:' + intent.requestId + ':' + output.kind,
          profileManifestCharge(output.file.manifest),
        );
    }
  const parent: ProfileLineageParent = {
    manifest: origin.manifest,
    database: join(originDir, 'runtime.sqlite'),
    assets,
    lineage: origin.manifest.lineage ? lineageDir : null,
    assetsCapture: parts.assetsCapture,
    lineageCapture: parts.lineageCapture,
  };
  session.budget.charge('lineage-parent-database', {
    stored: origin.manifest.bytes + Buffer.byteLength(JSON.stringify(origin.manifest)),
    logical: origin.manifest.bytes,
    entries: 2,
    metadata: Buffer.byteLength(JSON.stringify(origin.manifest)),
  });
  chargeCopy(session, 'lineage-parent-assets', parts.assetsCapture.manifest);
  if (parts.lineageCapture)
    chargeCopy(session, 'lineage-parent-lineage', parts.lineageCapture.manifest);
  return {
    inventory: partition.liveCoding,
    desktop: partition.liveDesktop,
    lineage: {
      parent,
      intents,
      lineage: {
        format: 1,
        parentSnapshotId: origin.snapshotId,
        codingInventory: inputs.inventory.hash,
        desktopInventory: profileHash(inputs.desktop),
        recordsHash: profileHash(inputs.restoration),
        tasks: partition.tasks,
        desktopSource: partition.desktopSource,
        intents: intents.map((intent) => ({
          requestId: intent.requestId,
          recordHash: intent.recordHash,
          state: intent.state,
          outputs: intent.outputs.map((output) => ({
            kind: output.kind,
            presence: output.presence,
            manifestHash: output.capture?.manifest.hash ?? output.file?.manifest.hash ?? null,
          })),
        })),
      },
    },
  };
}
