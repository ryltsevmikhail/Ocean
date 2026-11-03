import { packCodingGitObjects } from './coding-git-pack.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeBinding } from '@runnets/domain';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import {
  gitObjectStorage,
  readGitFile,
  readGitDescriptor,
  readGitBranch,
  unsupportedGitStorage,
} from './coding-git-storage.js';
export interface CodingGitObjectCapture {
  readonly format: 1;
  readonly baseCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly objectIds: readonly string[];
  readonly objectBytes: number;
  readonly index: Buffer;
  readonly indexSha256: string;
  readonly pack: Buffer;
  readonly packSha256: string;
}
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
/** Trusted local Git reads from pinned objects/index under a synthesized config, never source config. */
export function captureCodingGitObjects(
  binding: WorktreeBinding,
  preflight?: (root: number) => void,
): CodingGitObjectCapture {
  return observeCodingGitObjects(binding, false, preflight)!;
}
/** Internal metadata-only admission; no Git object body command is dispatched. */
export function preflightCodingGitObjects(
  binding: WorktreeBinding,
  preflight: (root: number) => void,
): void {
  observeCodingGitObjects(binding, true, preflight);
}
function observeCodingGitObjects(
  binding: WorktreeBinding,
  metadataOnly: boolean,
  preflight?: (root: number) => void,
): CodingGitObjectCapture | null {
  const { root, gitCommonDir: common, baseCommit, branch } = binding;
  if (
    process.platform !== 'linux' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) ||
    !/^codex\/ocean\/[a-f0-9]{64}$/.test(branch) ||
    fs.realpathSync(root) !== root ||
    fs.realpathSync(common) !== common
  )
    return unsupportedGitStorage();
  const rootFd = fs.openSync(root, assetDirectoryFlags);
  let commonFd: number | undefined,
    admin: number | undefined,
    objects: number | undefined,
    indexFd: number | undefined;
  try {
    commonFd = fs.openSync(common, assetDirectoryFlags);
    checkAssetPath(rootFd, root);
    checkAssetPath(commonFd, common);
    const pointer = readGitFile(rootFd, '.git', 4096).toString('utf8');
    if (!pointer.startsWith('gitdir: ') || !pointer.endsWith('\n')) return unsupportedGitStorage();
    const adminPath = resolve(root, pointer.slice(8, -1));
    if (
      dirname(adminPath) !== join(common, 'worktrees') ||
      fs.realpathSync(adminPath) !== adminPath
    )
      return unsupportedGitStorage();
    admin = fs.openSync(adminPath, assetDirectoryFlags);
    if (
      readGitFile(admin, 'HEAD', 256).toString() !== 'ref: refs/heads/' + branch + '\n' ||
      resolve(adminPath, readGitFile(admin, 'commondir', 4096).toString().trim()) !== common ||
      readGitFile(admin, 'gitdir', 4096).toString().trim() !== join(root, '.git') ||
      readGitBranch(commonFd, common, branch) !== baseCommit
    )
      return unsupportedGitStorage();
    objects = fs.openSync(join(assetFdPath(commonFd), 'objects'), assetDirectoryFlags);
    const objectPath = join(common, 'objects'),
      before = gitObjectStorage(objects, objectPath, baseCommit.length);
    const index = readGitFile(admin, 'index', 16777216);
    indexFd = fs.openSync(
      join(assetFdPath(admin), 'index'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    // The inherited descriptor must still identify the exact saved index bytes.
    if (
      !readGitDescriptor(indexFd, 16777216).equals(index) ||
      !readGitFile(admin, 'index', 16777216).equals(index)
    )
      throw Error('stale_coding_git_storage');
    preflight?.(rootFd);
    const packed = metadataOnly ? null : packCodingGitObjects(baseCommit, objects, indexFd);
    if (
      !readGitDescriptor(indexFd, 16777216).equals(index) ||
      !readGitFile(admin, 'index', 16777216).equals(index) ||
      before !== gitObjectStorage(objects, objectPath, baseCommit.length) ||
      readGitFile(rootFd, '.git', 4096).toString() !== pointer ||
      readGitFile(admin, 'HEAD', 256).toString() !== 'ref: refs/heads/' + branch + '\n' ||
      resolve(adminPath, readGitFile(admin, 'commondir', 4096).toString().trim()) !== common ||
      readGitFile(admin, 'gitdir', 4096).toString().trim() !== join(root, '.git') ||
      readGitBranch(commonFd, common, branch) !== baseCommit
    )
      throw Error('stale_coding_git_storage');
    checkAssetPath(rootFd, root);
    checkAssetPath(commonFd, common);
    checkAssetPath(admin, adminPath);
    return packed === null ? null : { ...packed, index, indexSha256: digest(index) };
  } finally {
    if (indexFd !== undefined) fs.closeSync(indexFd);
    if (objects !== undefined) fs.closeSync(objects);
    if (admin !== undefined) fs.closeSync(admin);
    fs.closeSync(rootFd);
    if (commonFd !== undefined) fs.closeSync(commonFd);
  }
}
