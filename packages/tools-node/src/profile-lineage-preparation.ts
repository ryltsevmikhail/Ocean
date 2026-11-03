import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import type {
  CodingAssetManifest,
  CodingBackupInventory,
  DesktopAssetInventory,
  ProfileBackupLineage,
  ProfileBackupManifest,
  ProfileIntentOutputKind,
  ProfileRebindRecord,
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
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
import { readLineageFile, type LineageFileCapture } from './profile-lineage-file.js';
import { desktopRootIdentity } from './desktop-assets.js';

const DIRECTORY_OUTPUTS: readonly ProfileIntentOutputKind[] = [
  'materialization',
  'git-administration',
  'desktop',
];
export type LineageOutputMode = 'directory' | 'file';
export interface LineageOutputPlan {
  readonly kind: ProfileIntentOutputKind;
  readonly path: string | null;
  readonly mode: LineageOutputMode;
  readonly presence: 'absent' | 'captured';
  readonly capture?: CodingAssetCapture;
  readonly file?: LineageFileCapture;
}
export interface LineageIntentPlan {
  readonly requestId: string;
  readonly recordHash: string;
  readonly state: ProfileRebindRecord['state'];
  readonly outputs: readonly LineageOutputPlan[];
}
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
const outputLimits = { bytes: 2147483648, entries: 100000, depth: 128 } as const;
function readPrivateFile(path: string, limit = 4096): Buffer {
  return readLineageFile(path, basename(path), limit).bytes;
}
function verifyFileContent(
  record: ProfileRebindRecord,
  kind: ProfileIntentOutputKind,
  bytes: Buffer,
): void {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw Error('unsupported_rebind_output');
  if (kind === 'registration') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw Error('unsupported_rebind_output');
    }
    if (JSON.stringify(value) !== JSON.stringify([record.preview.plan.registration]))
      throw Error('unsupported_rebind_output');
  } else if (kind === 'git-reference' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/.test(text))
    throw Error('unsupported_rebind_output');
}
function verifyReadyOutput(
  record: ProfileRebindRecord,
  kind: ProfileIntentOutputKind,
  path: string,
): void {
  const plan = record.preview.plan,
    result = record.result;
  if (!result) throw Error('missing_rebind_output');
  if (kind === 'materialization') {
    if (
      fs.realpathSync(plan.worktree.root) !== plan.worktree.root ||
      fs
        .readlinkSync(join(plan.managedDirectory, 'workspace'), { encoding: 'buffer' })
        .toString() !== basename(plan.worktree.root)
    )
      throw Error('unsupported_rebind_output');
  } else if (kind === 'git-administration') {
    const pointer = readPrivateFile(join(plan.worktree.root, '.git')).toString('utf8'),
      backlink = readPrivateFile(join(path, 'gitdir')).toString('utf8');
    if (
      pointer !== 'gitdir: ' + path + '\n' ||
      backlink !== join(plan.worktree.root, '.git') + '\n'
    )
      throw Error('unsupported_rebind_output');
  } else if (kind === 'desktop') {
    if (
      !result.desktop ||
      result.desktop.root !== path ||
      result.desktop.identity !== desktopRootIdentity(path)
    )
      throw Error('unsupported_rebind_output');
  }
}
/** Every selector comes from the durable plan. No caller argument can add or exclude one. */
export function lineageIntentOutputs(
  profile: string,
  record: ProfileRebindRecord,
): readonly {
  kind: ProfileIntentOutputKind;
  path: string | null;
  mode: LineageOutputMode;
}[] {
  const p = record.preview,
    plan = p.plan;
  if (
    plan.assetDirectory !== join(profile, 'rebind-' + p.epochId) ||
    plan.managedDirectory !== join(plan.assetDirectory, 'materialized/tree') ||
    plan.gitTemporaryRoot !== join(plan.assetDirectory, basename(plan.worktree.root)) ||
    basename(plan.worktree.root) === 'workspace' ||
    plan.worktree.root !==
      join(
        plan.managedDirectory,
        profileHash([p.ownerId, p.selection.projectRoot, p.successorTaskId]),
      ) ||
    plan.gitAdministration !==
      join(plan.worktree.gitCommonDir, 'worktrees', basename(plan.worktree.root))
  )
    throw Error('invalid_rebind_identity');
  return [
    { kind: 'materialization', path: plan.managedDirectory, mode: 'directory' },
    { kind: 'git-administration', path: plan.gitAdministration, mode: 'directory' },
    {
      kind: 'git-reference',
      path: join(plan.worktree.gitCommonDir, 'refs', 'heads', plan.worktree.branch),
      mode: 'file',
    },
    { kind: 'desktop', path: plan.desktop?.root ?? null, mode: 'directory' },
    { kind: 'registration', path: join(profile, 'coding-projects.json'), mode: 'file' },
  ];
}
function present(path: string): boolean {
  return fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
function shape(path: string, mode: LineageOutputMode): void {
  const stat = fs.lstatSync(path);
  if (mode === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    throw Error('invalid_rebind_output');
}
/** Ready evidence must be complete. Consumed states may prove absence or capture safe partial bytes only. */
export function requireLineageOutput(
  record: ProfileRebindRecord,
  kind: ProfileIntentOutputKind,
  value: boolean,
): void {
  const applicable = kind !== 'desktop' || record.preview.plan.desktop !== null;
  if (!applicable) {
    if (value) throw Error('unowned_rebind_output');
    return;
  }
  if (record.state === 'ready') {
    if (!value) throw Error('missing_rebind_output');
    return;
  }
  if (
    value &&
    (record.state === 'preview' ||
      record.state === 'refused' ||
      record.state === 'confirmed' ||
      !record.worktreeLease)
  )
    throw Error('unowned_rebind_output');
}
export function inspectLineageIntent(
  profile: string,
  record: ProfileRebindRecord,
): LineageIntentPlan {
  return {
    requestId: record.requestId,
    recordHash: profileHash(record),
    state: record.state,
    outputs: lineageIntentOutputs(profile, record).map((output) => captureOutput(record, output)),
  };
}
function captureOutput(
  record: ProfileRebindRecord,
  output: {
    kind: ProfileIntentOutputKind;
    path: string | null;
    mode: LineageOutputMode;
  },
): LineageOutputPlan {
  if (!output.path) return { ...output, presence: 'absent' };
  const exists = present(output.path);
  requireLineageOutput(record, output.kind, exists);
  if (!exists) return { ...output, presence: 'absent' };
  shape(output.path, output.mode);
  if (record.state === 'ready') verifyReadyOutput(record, output.kind, output.path);
  if (output.mode === 'file') {
    const file = readLineageFile(output.path, basename(output.path), 1048576);
    verifyFileContent(record, output.kind, file.bytes);
    return { ...output, presence: 'captured', file };
  }
  const capture = captureCodingAssetTree(output.path, outputLimits, 'all');
  try {
    if (DIRECTORY_OUTPUTS.includes(output.kind)) validateCodingAssetLinks(capture.manifest);
  } catch {
    throw Error('unsupported_rebind_output');
  }
  return { ...output, presence: 'captured', capture };
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
      { database: join(profile, 'restore-origin/runtime.sqlite'), assets, lineage: lineageDir },
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
