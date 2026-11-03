import { profileBackupSession } from './profile-backup-session.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
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
/** Internal wholegraph budget reservation; retains ready-specific original witnesses without narrowing its accepted namespace. */
export function reserveCodingGitObjects(binding: WorktreeBinding): void {
  observeCodingGitObjects(binding, 'reserve');
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
  metadataOnly: boolean | 'reserve',
  preflight?: (root: number) => void,
): CodingGitObjectCapture | null {
  profileBackupSession.getStore()?.checkMetadata();
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
  let retained = false;
  const heldFiles: { fd: number; path: string; state: string; mount: string; hash: string }[] = [];
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
    const boundPaths = [
      root,
      common,
      adminPath,
      join(root, '.git'),
      join(adminPath, 'HEAD'),
      join(adminPath, 'commondir'),
      join(adminPath, 'gitdir'),
      join(adminPath, 'index'),
      join(common, 'refs'),
      join(common, 'refs', 'heads'),
      join(common, 'refs', 'heads', 'codex'),
      join(common, 'refs', 'heads', 'codex', 'ocean'),
      join(common, 'refs', 'heads', branch),
      join(common, 'packed-refs'),
    ];
    const originalStates = boundPaths.map((path) => {
      const state = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
      return [path, state ? codingAssetIdentity(state) : null] as const;
    });
    if (profileBackupSession.getStore() && metadataOnly !== true)
      for (const [path, state] of originalStates) {
        if (!state || !fs.lstatSync(path).isFile()) continue;
        const fd = fs.openSync(
          path,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          if (codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state)
            throw Error('stale_coding_git_storage');
          heldFiles.push({
            fd,
            path,
            state,
            mount: codingAssetMount(fd),
            hash: digest(readGitDescriptor(fd, 16777216)),
          });
        } catch (error) {
          fs.closeSync(fd);
          throw error;
        }
      }
    const originalMount = codingAssetMount(objects);
    preflight?.(rootFd);
    const packed =
      metadataOnly === true
        ? null
        : packCodingGitObjects(baseCommit, objects, indexFd, root, metadataOnly === 'reserve');
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
    const result = packed === null ? null : { ...packed, index, indexSha256: digest(index) };
    const session = profileBackupSession.getStore();
    if (session && result) {
      const indexHash = result.indexSha256,
        packHash = result.packSha256,
        objectHash = digest(Buffer.from(JSON.stringify([result.objectIds, result.objectBytes])));
      const metadata = () => {
        for (const file of heldFiles) {
          const current = fs.openSync(file.path, 0x200000 | fs.constants.O_NOFOLLOW);
          try {
            if (
              codingAssetIdentity(fs.fstatSync(current, { bigint: true })) !== file.state ||
              codingAssetMount(current) !== file.mount ||
              codingAssetIdentity(fs.fstatSync(file.fd, { bigint: true })) !== file.state
            )
              throw Error('stale_coding_git_storage');
          } finally {
            fs.closeSync(current);
          }
          checkAssetPath(file.fd, file.path);
        }
        for (const [path, expected] of originalStates) {
          const current = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if ((current ? codingAssetIdentity(current) : null) !== expected)
            throw Error('stale_coding_git_storage');
        }
        checkAssetPath(rootFd, root);
        checkAssetPath(commonFd!, common);
        checkAssetPath(admin!, adminPath);
        checkAssetPath(objects!, objectPath);
        if (
          codingAssetMount(objects!) !== originalMount ||
          before !== gitObjectStorage(objects!, objectPath, baseCommit.length)
        )
          throw Error('stale_coding_git_storage');
      };
      retained = true;
      session.retain(
        (metadataOnly === 'reserve' ? 'git-plan:' : 'git:') + root,
        packHash + objectHash + indexHash,
        {
          metadata,
          bytes: () => {
            metadata();
            for (const file of heldFiles)
              if (digest(readGitDescriptor(file.fd, 16777216)) !== file.hash)
                throw Error('stale_coding_git_storage');
            const current = packCodingGitObjects(
              baseCommit,
              objects!,
              indexFd,
              root,
              metadataOnly === 'reserve',
            );
            if (
              digest(readGitDescriptor(indexFd!, 16777216)) !== indexHash ||
              current.packSha256 !== packHash ||
              digest(Buffer.from(JSON.stringify([current.objectIds, current.objectBytes]))) !==
                objectHash
            )
              throw Error('stale_coding_git_storage');
          },
          close: () => {
            for (const file of heldFiles) fs.closeSync(file.fd);
            for (const fd of [indexFd, objects, admin, commonFd, rootFd])
              if (fd !== undefined) fs.closeSync(fd);
          },
        },
      );
    }
    return result;
  } finally {
    if (!retained) for (const file of heldFiles) fs.closeSync(file.fd);
    if (!retained && indexFd !== undefined) fs.closeSync(indexFd);
    if (!retained && objects !== undefined) fs.closeSync(objects);
    if (!retained && admin !== undefined) fs.closeSync(admin);
    if (!retained) fs.closeSync(rootFd);
    if (!retained && commonFd !== undefined) fs.closeSync(commonFd);
  }
}
