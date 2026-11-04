import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import type { ProfileIntentOutputKind, ProfileRebindRecord } from '@runnets/domain';
import type { CodingAssetCapture } from './coding-asset-state.js';
import { profileHash } from './profile-backup-output.js';
import { captureAssetTreeAt, captureCodingAssetTree } from './coding-asset-scan.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
import { readLineageFile, type LineageFileCapture } from './profile-lineage-file.js';
import { desktopBindingMatches, withDesktopRoot } from './desktop-root.js';

const DIRECTORY_OUTPUTS: readonly ProfileIntentOutputKind[] = [
  'materialization',
  'git-administration',
  'desktop',
];
const outputLimits = { bytes: 2147483648, entries: 100000, depth: 128 } as const;
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
    if (!result.desktop || result.desktop.root !== path || !desktopBindingMatches(result.desktop))
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
/** An existing Git administration is only archivable when it still names this attempt's worktree. */
function verifyGitAdministration(record: ProfileRebindRecord, path: string): void {
  try {
    if (
      readPrivateFile(join(path, 'gitdir')).toString('utf8') !==
      join(record.preview.plan.worktree.root, '.git') + '\n'
    )
      throw Error('unsupported_rebind_output');
  } catch {
    throw Error('unsupported_rebind_output');
  }
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
  if (output.kind === 'git-administration') verifyGitAdministration(record, output.path);
  if (record.state === 'ready') verifyReadyOutput(record, output.kind, output.path);
  if (output.mode === 'file') {
    const file = readLineageFile(output.path, basename(output.path), 1048576);
    verifyFileContent(record, output.kind, file.bytes);
    return { ...output, presence: 'captured', file };
  }
  const capture =
    record.state === 'ready' && output.kind === 'desktop' && record.result?.desktop
      ? withDesktopRoot(record.result.desktop, (held) =>
          captureAssetTreeAt(output.path!, outputLimits, 'all', held.fd),
        )
      : captureCodingAssetTree(output.path, outputLimits, 'all');
  try {
    if (DIRECTORY_OUTPUTS.includes(output.kind)) validateCodingAssetLinks(capture.manifest);
  } catch {
    throw Error('unsupported_rebind_output');
  }
  return { ...output, presence: 'captured', capture };
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
