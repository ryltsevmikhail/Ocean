import * as fs from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import {
  privateAssetDirectory,
  privateAssetChild,
  assetDirectoryFlags,
  assetFdPath,
  checkAssetPath,
} from './coding-asset-io.js';
import { codingAssetMount, codingAssetIdentity } from './coding-asset-scan.js';
import { readGitDescriptor } from './coding-git-storage.js';
import { invalidInventory, graphHash, type Worktree } from './coding-recovery-plan.js';
function namesPath(value: string, from: string, destination: string): boolean {
  return value === destination + '\n' || value === relative(from, destination) + '\n';
}
/** Verify only the frozen managed checkout's pointer and named administrative backpointers. */
export function verifyRecoveryBinding(tree: Worktree) {
  const { root, gitCommonDir: common } = tree,
    opened: number[] = [];
  const keep = (fd: number) => {
    opened.push(fd);
    return fd;
  };
  const evidence: unknown[] = [];
  const state = (fd: number) => codingAssetIdentity(fs.fstatSync(fd, { bigint: true }));
  const pointer = (parent: number, name: string, canonical: string, mount: string) => {
    const file = fs.openSync(
      join(assetFdPath(parent), name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = state(file);
      if (codingAssetMount(parent) !== mount || codingAssetMount(file) !== mount)
        return invalidInventory();
      checkAssetPath(file, join(canonical, name));
      const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readGitDescriptor(file, 4096),
      );
      if (
        state(file) !== before ||
        codingAssetIdentity(fs.lstatSync(join(assetFdPath(parent), name), { bigint: true })) !==
          before
      )
        return invalidInventory();
      evidence.push([name, before, mount, value]);
      return value;
    } finally {
      fs.closeSync(file);
    }
  };
  try {
    const managed = keep(privateAssetDirectory(dirname(root))),
      checkout = keep(privateAssetChild(managed, basename(root), root));
    const managedMount = codingAssetMount(managed);
    if (codingAssetMount(checkout) !== managedMount) return invalidInventory();
    const gitdir = pointer(checkout, '.git', root, managedMount);
    if (!gitdir.startsWith('gitdir: ') || !gitdir.endsWith('\n')) return invalidInventory();
    const adminPath = resolve(root, gitdir.slice(8, -1));
    if (
      !namesPath(gitdir.slice(8), root, adminPath) ||
      dirname(adminPath) !== join(common, 'worktrees') ||
      fs.realpathSync(common) !== common
    )
      return invalidInventory();
    const commonFd = keep(fs.openSync(common, assetDirectoryFlags)),
      parent = keep(fs.openSync(join(assetFdPath(commonFd), 'worktrees'), assetDirectoryFlags)),
      admin = keep(
        fs.openSync(join(assetFdPath(parent), basename(adminPath)), assetDirectoryFlags),
      );
    const mount = codingAssetMount(commonFd);
    for (const [fd, path] of [
      [commonFd, common],
      [parent, dirname(adminPath)],
      [admin, adminPath],
    ] as const) {
      if (fs.fstatSync(fd).uid !== process.getuid?.() || codingAssetMount(fd) !== mount)
        return invalidInventory();
      checkAssetPath(fd, path);
      evidence.push([path, state(fd), mount]);
    }
    if (
      pointer(admin, 'HEAD', adminPath, mount) !== 'ref: refs/heads/' + tree.branch + '\n' ||
      !namesPath(pointer(admin, 'gitdir', adminPath, mount), adminPath, join(root, '.git')) ||
      !namesPath(pointer(admin, 'commondir', adminPath, mount), adminPath, common)
    )
      return invalidInventory();
    checkAssetPath(checkout, root);
    checkAssetPath(commonFd, common);
    checkAssetPath(admin, adminPath);
    return {
      hash: graphHash([managedMount, state(managed), state(checkout), evidence]),
      commonState: state(commonFd),
      mount,
    };
  } finally {
    for (const fd of opened.reverse()) fs.closeSync(fd);
  }
}
