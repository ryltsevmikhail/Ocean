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
export function observeRecoveryDirectories<T>(
  common: string,
  names: readonly string[],
  observe: (directories: ScopeDirectory[], witness: string) => T,
  expected?: { commonState: string; mount: string },
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
    const commonDir = pin(common, common);
    if (
      expected &&
      (commonDir.state !== expected.commonState ||
        codingAssetMount(commonDir.fd) !== expected.mount)
    )
      throw Error('stale_coding_asset');
    let current = commonDir;
    for (const name of names) {
      const next = child(current, name);
      if (!next) break;
      current = next;
    }
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
    const result = observe(
      opened,
      JSON.stringify(opened.map((dir) => [dir.path, dir.state, codingAssetMount(dir.fd)])),
    );
    check();
    return result;
  } finally {
    for (const { fd } of opened.reverse()) fs.closeSync(fd);
  }
}

export function observeRecoverySource<T>(
  common: string,
  slot: string,
  observe: (source: RecoverySource, witness: string) => T,
  expected?: { commonState: string; mount: string },
): T {
  return observeRecoveryDirectories(
    common,
    ['ocean-apply-recovery-v2', slot, 'files'],
    (dirs, witness) => {
      const leaf = dirs[2],
        files = dirs[3];
      return observe({ ...(leaf && { leaf }), ...(files && { files }) }, witness);
    },
    expected,
  );
}
