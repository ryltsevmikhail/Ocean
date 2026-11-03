import * as fs from 'node:fs';
import { checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
/** An old descriptor can survive an overmount. Compare the currently named object without reading it. */
export function checkDependencyPath(fd: number, path: string): void {
  const current = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
  try {
    checkAssetPath(fd, path);
    checkAssetPath(current, path);
    if (
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !==
        codingAssetIdentity(fs.fstatSync(current, { bigint: true })) ||
      codingAssetMount(fd) !== codingAssetMount(current)
    )
      throw Error('stale_coding_asset');
  } finally {
    fs.closeSync(current);
  }
}
