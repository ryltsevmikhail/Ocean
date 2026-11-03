import { checkDependencyPath } from './coding-dependency-path.js';
import * as fs from 'node:fs';
import { assetDirectoryFlags } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { dependencyFail } from './coding-dependency-config.js';
/** Pin only explicitly declared mapping roots. No contents or original project bodies are visited. */
export function holdDependencyMappingRoot(path: string) {
  if (fs.realpathSync(path) !== path) return dependencyFail();
  const fd = fs.openSync(path, assetDirectoryFlags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true }),
      state = codingAssetIdentity(stat),
      mount = codingAssetMount(fd);
    if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o7000n) !== 0n)
      return dependencyFail();
    const verify = () => {
      checkDependencyPath(fd, path);
      if (
        codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
        codingAssetIdentity(fs.lstatSync(path, { bigint: true })) !== state ||
        codingAssetMount(fd) !== mount
      )
        throw Error('stale_coding_asset');
    };
    verify();
    return { verify, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
