import { reserveCodingGitObjects } from './coding-git-backup.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { CodingWorktree } from '@runnets/domain';
import { GitEvidenceObserver } from './coding-git-observer.js';
import { observeGitAdministration } from './coding-git-administration.js';
import { gitObjectStorage } from './coding-git-storage.js';
import { packCodingGitObjects } from './coding-git-pack.js';
import { assetFdPath } from './coding-asset-io.js';
import type { ProfileBackupSession } from './profile-backup-session.js';
import { profileHash } from './profile-backup-output.js';
/** Reserve every explicit Git closure before the first tree/archive consumer; retain original administrative witnesses. */
export function prepareProfileGit(
  session: ProfileBackupSession,
  bindings: readonly CodingWorktree[],
  managedPath: string,
): void {
  for (const binding of bindings) {
    if (binding.state === 'ready') {
      reserveCodingGitObjects(binding);
      continue;
    }
    const observer = new GitEvidenceObserver();
    let index: number | undefined;
    try {
      const managed = observer.directory(managedPath);
      const observation = observeGitAdministration(binding, observer, managed);
      const { objects } = observation,
        objectPath = join(binding.gitCommonDir, 'objects');
      const storage = gitObjectStorage(objects, objectPath, binding.baseCommit.length);
      if (observation.index !== null)
        index = fs.openSync(
          join(assetFdPath(observation.admin!), 'index'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      const reserve = () =>
        packCodingGitObjects(binding.baseCommit, objects, index, binding.root, true);
      const original = profileHash(reserve());
      observer.verify();
      session.retain('git-plan:' + binding.root, original, {
        metadata: () => {
          observer.verify(true);
          if (gitObjectStorage(objects, objectPath, binding.baseCommit.length) !== storage)
            throw Error('stale_coding_git_storage');
        },
        bytes: () => {
          observer.verify();
          if (profileHash(reserve()) !== original) throw Error('stale_coding_git_storage');
        },
        close: () => {
          if (index !== undefined) fs.closeSync(index);
          observer.close();
        },
      });
    } catch (error) {
      if (index !== undefined) fs.closeSync(index);
      observer.close();
      throw error;
    }
  }
}
