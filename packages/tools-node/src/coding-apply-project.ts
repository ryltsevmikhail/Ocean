import { constants } from 'node:fs';
import { mkdir, realpath, open } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import type { CodingApplyProjectPort, CodingApplyObservationPort } from '@runnets/application';
import type { CodingTask, CodingFileChange } from '@runnets/domain';
import { GitCodingProject } from './coding-project.js';
import { GitCodingSnapshots } from './coding-snapshot.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { codingGit, codingText } from './coding-git.js';
import { observeCodingFiles } from './coding-apply-observation.js';
import { applyCodingFile } from './coding-apply-file.js';
/** Trusted owner-application adapter; never stages, commits, cleans or invokes project code. */
export class GitCodingApplyProject implements CodingApplyProjectPort, CodingApplyObservationPort {
  observe(
    root: string,
    paths: readonly string[],
  ): ReturnType<CodingApplyObservationPort['observe']> {
    return Promise.resolve(observeCodingFiles(root, paths));
  }
  async inspect(root: string): ReturnType<CodingApplyProjectPort['inspect']> {
    const project = await new GitCodingProject().inspect(root);
    if (project.root !== root) throw Error('canonical project root required');
    return project;
  }
  async sourceTree(task: CodingTask): Promise<string> {
    if (!task.worktreeRoot) throw Error('task worktree required');
    const plan = await new GitCodingWorktrees(dirname(task.worktreeRoot)).plan(task);
    if (plan.root !== task.worktreeRoot) throw Error('task worktree mismatch');
    const artifact = await new GitCodingSnapshots().capture(task, {
      ...plan,
      taskId: task.id,
      projectRoot: task.projectRoot,
      baseCommit: task.baseCommit,
    });
    return artifact.afterTreeHash;
  }
  async applyFile(root: string, change: CodingFileChange): Promise<void> {
    if ((await realpath(root)) !== root) throw Error('canonical project root required');
    const common = await realpath(
      resolve(root, codingText(await codingGit(root, ['rev-parse', '--git-common-dir'])).trim()),
    );
    const recovery = join(common, 'ocean-apply-recovery');
    const directory = await open(
      common,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      try {
        await mkdir('/proc/self/fd/' + String(directory.fd) + '/ocean-apply-recovery', {
          mode: 0o700,
        });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
    applyCodingFile(root, recovery, change);
  }
}
