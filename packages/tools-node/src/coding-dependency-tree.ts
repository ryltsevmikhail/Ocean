import * as fs from 'node:fs';
import { assetDirectoryFlags } from './coding-asset-io.js';
import { checkDependencyPath } from './coding-dependency-path.js';
import { captureAssetTreeAt, type CodingAssetCapture } from './coding-asset-scan.js';
import { scanAssetSource } from './coding-asset-source.js';
/** The caller supplies a private originating snapshot, never a consumer-owned DTO. */
export function holdDependencyTree(expected: CodingAssetCapture) {
  const fd = fs.openSync(expected.root, assetDirectoryFlags);
  const checkMetadata = (current: CodingAssetCapture) => {
    if (current.sourceStateHash !== expected.sourceStateHash) throw Error('stale_coding_asset');
  };
  try {
    checkDependencyPath(fd, expected.root);
    checkMetadata(
      scanAssetSource(
        expected.root,
        expected.limits,
        expected.policy,
        { entries: new Map(expected.sourceEntries), mount: expected.sourceMount },
        true,
        fd,
      ),
    );
    return {
      capture: () => {
        checkDependencyPath(fd, expected.root);
        const current = captureAssetTreeAt(
          expected.root,
          expected.limits,
          expected.policy,
          fd,
          checkMetadata,
        );
        if (current.manifest.hash !== expected.manifest.hash) throw Error('stale_coding_asset');
        return current;
      },
      close: () => fs.closeSync(fd),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
