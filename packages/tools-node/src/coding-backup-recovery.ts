import { readCodingRecoveryRecords } from './coding-recovery-evidence.js';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { captureCodingAssetTree, type CodingAssetCapture } from './coding-asset-scan.js';
import { checkAssetPath, privateAssetDirectory } from './coding-asset-io.js';
import { invalidRecovery } from './coding-recovery-record.js';
export interface CodingApplyRecoveryCapture {
  readonly capture: CodingAssetCapture;
  readonly records: readonly {
    readonly id: string;
    readonly root: string;
    readonly path: string;
    readonly status: 'started' | 'completed';
    readonly nextOpaque: boolean;
  }[];
}
/** A selected, scoped recovery directory only; record status never settles a runtime receipt. */
export function captureCodingApplyRecovery(
  directory: string,
  projectRoots: readonly string[],
): CodingApplyRecoveryCapture {
  if (
    !projectRoots.length ||
    projectRoots.length > 1000 ||
    projectRoots.some(
      (root) =>
        typeof root !== 'string' ||
        root.length > 4096 ||
        root.includes('\0') ||
        resolve(root) !== root,
    )
  )
    return invalidRecovery();
  const projects = new Set(projectRoots),
    root = privateAssetDirectory(directory);
  try {
    const capture = captureCodingAssetTree(directory, {}, 'coding-recovery');
    const records = readCodingRecoveryRecords(capture, root, projects, '').map(
      ({ id, root, path, status, nextOpaque }) => ({ id, root, path, status, nextOpaque }),
    );
    const after = captureCodingAssetTree(directory, capture.limits, 'coding-recovery');
    if (
      after.sourceStateHash !== capture.sourceStateHash ||
      after.manifest.hash !== capture.manifest.hash
    )
      throw Error('stale_coding_asset');
    checkAssetPath(root, directory);
    return { capture, records };
  } finally {
    fs.closeSync(root);
  }
}
