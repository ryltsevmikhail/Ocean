import { profileBackupSession } from './profile-backup-session.js';
import { registerPartialGit } from './coding-git-partial-origin.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { WorktreeBinding } from '@runnets/domain';
import { codingAssetMount } from './coding-asset-state.js';
import { assetFdPath } from './coding-asset-io.js';
import { GitEvidenceObserver, gitDigest } from './coding-git-observer.js';
import {
  observeGitAdministration,
  type CodingGitAdministration,
} from './coding-git-administration.js';
import { gitObjectStorage, readGitDescriptor } from './coding-git-storage.js';
import { packCodingGitObjects } from './coding-git-pack.js';
import type { CodingGitObjectCapture } from './coding-git-backup.js';
export interface CodingPartialGitCapture extends Omit<
  CodingGitObjectCapture,
  'index' | 'indexSha256'
> {
  readonly index: Buffer | null;
  readonly indexSha256: string | null;
  readonly administration: CodingGitAdministration;
}
/** Prove only metadata before any selected root can dispatch object-body reads. */
export function preflightPartialCodingGit(
  binding: WorktreeBinding,
  managedDirectory: string,
  preflight: (root: number) => void,
): void {
  const observer = new GitEvidenceObserver();
  try {
    const managed = observer.directory(managedDirectory);
    if (managed !== null && fs.fstatSync(managed).mode & 0o077)
      throw Error('invalid_coding_asset_root');
    const observation = observeGitAdministration(binding, observer, managed);
    gitObjectStorage(
      observation.objects,
      join(binding.gitCommonDir, 'objects'),
      binding.baseCommit.length,
    );
    if (observation.rootFd !== null) preflight(observation.rootFd);
    observer.verify();
  } finally {
    observer.close();
  }
}
/** Internal held observation: caller must close only after the last graph consumer/recheck. */
export function holdPartialCodingGit(
  binding: WorktreeBinding,
  managedDirectory: string,
  preflight?: (root: number) => void,
) {
  profileBackupSession.getStore()?.checkMetadata();
  const observer = new GitEvidenceObserver();
  let indexFd: number | undefined;
  try {
    const managed = observer.directory(managedDirectory);
    if (managed !== null && fs.fstatSync(managed).mode & 0o077)
      throw Error('invalid_coding_asset_root');
    const observation = observeGitAdministration(binding, observer, managed);
    const { objects, index, admin, administration } = observation;
    const objectPath = join(binding.gitCommonDir, 'objects');
    const storage = gitObjectStorage(objects, objectPath, binding.baseCommit.length);
    if (index !== null) {
      indexFd = fs.openSync(
        join(assetFdPath(admin!), 'index'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      if (
        codingAssetMount(indexFd) !== codingAssetMount(admin!) ||
        !readGitDescriptor(indexFd, 16777216).equals(index)
      )
        throw Error('stale_coding_git_storage');
    }
    observer.verify();
    if (observation.rootFd !== null) preflight?.(observation.rootFd);
    observer.verify();
    const packed = packCodingGitObjects(binding.baseCommit, objects, indexFd, binding.root);
    const indexHash = index === null ? null : gitDigest(index),
      packHash = packed.packSha256;
    let active = true;
    const verify = () => {
      if (!active) throw Error('closed_coding_git_capture');
      observer.verify();
      if (indexFd !== undefined && gitDigest(readGitDescriptor(indexFd, 16777216)) !== indexHash)
        throw Error('stale_coding_git_storage');
      if (storage !== gitObjectStorage(objects, objectPath, binding.baseCommit.length))
        throw Error('stale_coding_git_storage');
      if (
        packCodingGitObjects(binding.baseCommit, objects, indexFd, binding.root).packSha256 !==
        packHash
      )
        throw Error('stale_coding_git_storage');
      observer.verify();
    };
    observer.verify();
    if (storage !== gitObjectStorage(objects, objectPath, binding.baseCommit.length))
      throw Error('stale_coding_git_storage');
    const capture: CodingPartialGitCapture = {
      ...packed,
      index,
      indexSha256: indexHash,
      administration,
    };
    registerPartialGit(capture, verify, [
      managedDirectory,
      binding.gitCommonDir,
      binding.projectRoot,
    ]);
    const close = () => {
      active = false;
      if (indexFd !== undefined) fs.closeSync(indexFd);
      observer.close();
    };
    const session = profileBackupSession.getStore();
    if (session)
      session.retain('partial-git:' + binding.root, packHash + ':' + indexHash, {
        metadata: () => {
          observer.verify(true);
          if (storage !== gitObjectStorage(objects, objectPath, binding.baseCommit.length))
            throw Error('stale_coding_git_storage');
        },
        bytes: verify,
        close,
      });
    return {
      capture,
      rootFd: observation.rootFd,
      verifyBinding: () => observer.verify(),
      verify,
      close: () => {
        if (!session) close();
      },
    };
  } catch (error) {
    if (indexFd !== undefined) fs.closeSync(indexFd);
    observer.close();
    throw error;
  }
}
