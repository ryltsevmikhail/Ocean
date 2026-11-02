import * as fs from 'node:fs';
import { join } from 'node:path';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import { invalidRecovery } from './coding-recovery-record.js';

interface ScopeDirectory {
  readonly fd: number;
  readonly path: string;
  readonly state: string;
}
export interface RecoverySource {
  readonly leaf?: ScopeDirectory;
  readonly files?: ScopeDirectory;
}
/** Pins only the named children of the caller's canonical common directory. Never creates a source. */
export function observeRecoverySource<T>(
  common: string,
  slot: string,
  observe: (source: RecoverySource) => T,
): T {
  if (process.platform !== 'linux' || fs.realpathSync(common) !== common) return invalidRecovery();
  const opened: ScopeDirectory[] = [];
  const pin = (path: string, at: string, parent?: ScopeDirectory): ScopeDirectory => {
    const fd = fs.openSync(at, assetDirectoryFlags);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (parent &&
          ((stat.mode & 0o7077n) !== 0n || codingAssetMount(fd) !== codingAssetMount(parent.fd)))
      )
        return invalidRecovery();
      checkAssetPath(fd, path);
      const directory = { fd, path, state: codingAssetIdentity(stat) };
      opened.push(directory);
      return directory;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  let missing: string | undefined;
  const child = (parent: ScopeDirectory, name: string) => {
    const at = join(assetFdPath(parent.fd), name);
    if (!fs.lstatSync(at, { throwIfNoEntry: false })) {
      missing = at;
      return undefined;
    }
    return pin(join(parent.path, name), at, parent);
  };
  try {
    const commonDir = pin(common, common),
      parent = child(commonDir, 'ocean-apply-recovery-v2');
    const leaf = parent && child(parent, slot),
      files = leaf && child(leaf, 'files');
    const check = () => {
      for (const { fd, path, state } of opened) {
        checkAssetPath(fd, path);
        if (
          codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
          codingAssetIdentity(fs.lstatSync(path, { bigint: true })) !== state
        )
          throw Error('stale_coding_asset');
      }
      if (missing && fs.lstatSync(missing, { throwIfNoEntry: false }))
        throw Error('stale_coding_asset');
    };
    check();
    const result = observe({ ...(leaf && { leaf }), ...(files && { files }) });
    check();
    return result;
  } finally {
    for (const { fd } of opened.reverse()) fs.closeSync(fd);
  }
}
