import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  CodingApplyProjectPort,
  CodingApplyObservationPort,
  CodingApplyTreePort,
} from '@runnets/application';
import type { CodingTask, CodingFileChange, CodingApplyContext } from '@runnets/domain';
import { GitCodingProject } from './coding-project.js';
import { GitCodingSnapshots } from './coding-snapshot.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { codingGit, codingText } from './coding-git.js';
import { captureCodingProjectTree } from './coding-project-tree.js';
import { observeCodingFiles } from './coding-apply-observation.js';
import { applyCodingFile } from './coding-apply-file.js';
import { withCodingApplyRecovery } from './coding-apply-scope.js';
/** Trusted owner-application adapter; never stages, commits, cleans or invokes project code. */
export class GitCodingApplyProject
  implements CodingApplyProjectPort, CodingApplyObservationPort, CodingApplyTreePort
{
  tree(root: string, expectedBase: string): Promise<string> {
    return captureCodingProjectTree(root, expectedBase);
  }
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
  async applyFile(
    root: string,
    change: CodingFileChange,
    context: CodingApplyContext,
  ): Promise<void> {
    const operation = structuredClone(context),
      file = structuredClone(change);
    if ((await realpath(root)) !== root) throw Error('canonical project root required');
    const common = await realpath(
      resolve(root, codingText(await codingGit(root, ['rev-parse', '--git-common-dir'])).trim()),
    );
    withCodingApplyRecovery(common, root, operation, (recovery) => {
      applyCodingFile(root, recovery, file);
    });
  }
}
