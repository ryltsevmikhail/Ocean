import { createHash } from 'node:crypto';
import { scanAssetSource } from './coding-asset-source.js';
import { planAssetSelection } from './coding-asset-selection.js';
import type { CodingAssetPolicy } from './coding-asset-policy.js';
import {
  CODING_ASSET_LIMITS,
  type CodingAssetLimits,
  type CodingAssetCapture,
} from './coding-asset-state.js';
export {
  codingAssetIdentity,
  codingAssetMount,
  CODING_ASSET_LIMITS,
  type CodingAssetLimits,
  type CodingAssetCapture,
} from './coding-asset-state.js';
export type { CodingAssetPolicy } from './coding-asset-policy.js';
// Only captures issued in this process can authorize another source observation.
// Portable manifests remain independently usable by archive verification and restore.
const issuedCaptures = new WeakMap<CodingAssetCapture, string>();
const captureDigest = (capture: CodingAssetCapture) =>
  createHash('sha256').update(JSON.stringify(capture)).digest('hex');
export function checkedArchiveInput(handle: CodingAssetCapture): CodingAssetCapture {
  const digest = issuedCaptures.get(handle);
  if (!digest) throw Error('invalid_coding_asset_capture');
  const snapshot = structuredClone(handle);
  if (captureDigest(snapshot) !== digest) throw Error('invalid_coding_asset_capture');
  return snapshot;
}
/** Captures a selected root only. Symlinks are inert text; a separate graph resolver must prove completeness. */
export function captureCodingAssetTree(
  root: string,
  options: Partial<CodingAssetLimits> = {},
  policy: CodingAssetPolicy = 'all',
): CodingAssetCapture {
  return captureAssetTreeAt(root, options, policy);
}
export function captureCodingAssetFiles(
  root: string,
  paths: readonly string[],
  options: Partial<CodingAssetLimits> = {},
  policy: 'coding-worktree' | 'coding-recovery' = 'coding-worktree',
): CodingAssetCapture {
  if (!Array.isArray(paths) || (policy !== 'coding-worktree' && policy !== 'coding-recovery'))
    throw Error('invalid_coding_asset_selection');
  return captureAssetTreeAt(root, options, policy, undefined, undefined, paths);
}
/** Internal entry point for a source already pinned by a trusted collector. */
export function captureAssetTreeAt(
  root: string,
  options: Partial<CodingAssetLimits>,
  policy: CodingAssetPolicy,
  pinned?: number,
  preflight?: (metadata: CodingAssetCapture) => void,
  paths?: readonly string[],
): CodingAssetCapture {
  if (
    ![
      'all',
      'coding-worktree',
      'coding-recovery',
      'coding-recovery-v2',
      'classified-legacy',
    ].includes(policy)
  )
    throw Error('unsupported_coding_asset');
  const limits = { ...CODING_ASSET_LIMITS, ...options };
  for (const key of ['bytes', 'entries', 'depth'] as const)
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < (key === 'entries' ? 1 : 0) ||
      limits[key] > CODING_ASSET_LIMITS[key]
    )
      throw Error('coding_asset_limit');
  if (
    (policy === 'classified-legacy' && paths === undefined) ||
    (paths !== undefined &&
      !['coding-worktree', 'coding-recovery', 'classified-legacy'].includes(policy))
  )
    throw Error('unsupported_coding_asset');
  const selection = paths === undefined ? undefined : planAssetSelection(paths, limits);
  const metadata =
    policy !== 'all'
      ? scanAssetSource(root, limits, policy, undefined, true, pinned, selection)
      : undefined;
  const expected = metadata && {
    entries: new Map(metadata.sourceEntries),
    mount: metadata.sourceMount,
  };
  if (metadata) preflight?.(metadata);
  const first = scanAssetSource(root, limits, policy, expected, false, pinned, selection),
    second = scanAssetSource(root, limits, policy, expected, false, pinned, selection);
  if (
    first.manifest.hash !== second.manifest.hash ||
    first.sourceStateHash !== second.sourceStateHash
  )
    throw Error('stale_coding_asset');
  issuedCaptures.set(first, captureDigest(first));
  return first;
}
/** Verify captured bytes as well as source identities after consuming the evidence. */
export function checkAssetTreeAt(capture: CodingAssetCapture, pinned: number): void {
  const after = scanAssetSource(
    capture.root,
    capture.limits,
    capture.policy,
    { entries: new Map(capture.sourceEntries), mount: capture.sourceMount },
    false,
    pinned,
    capture.manifest.selectedFiles &&
      planAssetSelection(capture.manifest.selectedFiles, capture.limits),
  );
  if (
    after.sourceStateHash !== capture.sourceStateHash ||
    after.manifest.hash !== capture.manifest.hash
  )
    throw Error('stale_coding_asset');
}
