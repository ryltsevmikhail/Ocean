import * as fs from 'node:fs';
import type { DesktopBinding } from '@runnets/domain';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { desktopBtrfsAnchor } from './desktop-btrfs-anchor.js';
import { desktopIdentityMode, validDesktopBindingShape } from './desktop-identity.js';
const fail = (): never => {
  throw Error('desktop_binding_mismatch');
};
function transient(stat: fs.BigIntStats, mount: string) {
  return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, mount].join(':');
}
/** The descriptor and current path stay pinned through the consumer, never derived from durable fields. */
export function holdDesktopRoot(root: string, expected?: string) {
  if (fs.realpathSync(root) !== root) return fail();
  const fd = fs.openSync(root, assetDirectoryFlags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true }),
      mount = codingAssetMount(fd);
    if (
      !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o777n) !== 0o700n
    )
      return fail();
    const state = codingAssetIdentity(stat),
      exact = transient(stat, mount);
    const verify = (mutable = false) => {
      checkAssetPath(fd, root);
      if (fs.realpathSync(root) !== root) fail();
      const live = fs.fstatSync(fd, { bigint: true }),
        path = fs.lstatSync(root, { bigint: true });
      if (
        codingAssetMount(fd) !== mount ||
        transient(live, mount) !== exact ||
        codingAssetIdentity(live) !== codingAssetIdentity(path) ||
        (!mutable && codingAssetIdentity(live) !== state)
      )
        fail();
      const current = fs.openSync(root, assetDirectoryFlags);
      try {
        if (
          codingAssetMount(current) !== mount ||
          codingAssetIdentity(fs.fstatSync(current, { bigint: true })) !== codingAssetIdentity(live)
        )
          fail();
      } finally {
        fs.closeSync(current);
      }
    };
    verify();
    const mode = expected === undefined ? undefined : desktopIdentityMode(expected);
    if (mode === null) return fail();
    let identity = exact;
    if (mode !== 'legacy-exact') {
      const anchor = desktopBtrfsAnchor(fd);
      if (anchor !== null) identity = [anchor, stat.uid, stat.gid, stat.mode].join(':');
      if (!desktopIdentityMode(identity) || (mode === 'linux-btrfs-v1' && anchor === null))
        return fail();
      verify(); // Full ctime/device/mount/path witness around the isolated helper.
    }
    if (expected !== undefined && identity !== expected) return fail();
    return { fd, path: assetFdPath(fd), mount, identity, verify, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function withDesktopRoot<T>(
  binding: DesktopBinding,
  consume: (root: ReturnType<typeof holdDesktopRoot>) => T,
  mutable = false,
): T {
  if (!validDesktopBindingShape(binding)) return fail();
  const held = holdDesktopRoot(binding.root, binding.identity);
  try {
    const result = consume(held);
    held.verify(mutable);
    return result;
  } finally {
    held.close();
  }
}
export function desktopBindingIdentity(root: string): string {
  const held = holdDesktopRoot(root);
  try {
    held.verify();
    return held.identity;
  } finally {
    held.close();
  }
}
export function desktopBindingMatches(binding: DesktopBinding): boolean {
  return withDesktopRoot(binding, () => true);
}
