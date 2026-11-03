import type { CodingTask } from '@runnets/domain';
import { CodingTurnRefusal } from '../coding-turn-factory.js';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { RuntimeOptions } from '../runtime.js';
import { readCodingProjects } from './coding-projects.js';
import { codingApprovalOwner } from './coding-approval.js';

export function registeredCodingTools(
  profile?: string,
): NonNullable<RuntimeOptions['codingTools']> {
  const resolveSandbox = async (task: CodingTask, prepare: boolean) => {
    const project = (await readCodingProjects(profile)).find((p) => p.root === task.projectRoot);
    if (
      !project ||
      !task.worktreeRoot ||
      JSON.stringify(project.testPresets) !== JSON.stringify(task.policy.testPresets)
    )
      throw new CodingTurnRefusal('project registration does not match task policy');
    for (const mount of project.mounts) {
      if (!mount.target.startsWith('/workspace/')) continue;
      const destination = join(task.worktreeRoot, relative('/workspace', mount.target));
      if ((await realpath(dirname(destination))) !== dirname(destination))
        throw Error('noncanonical dependency destination');
      try {
        const stat = await lstat(destination);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error('invalid dependency destination');
      } catch (error) {
        if (!prepare || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
          throw error;
        await mkdir(destination);
      }
    }
    return {
      root: task.worktreeRoot,
      mounts: project.mounts,
      ...(project.dependencyProjectRoot
        ? { dependencyProjectRoot: project.dependencyProjectRoot }
        : {}),
    };
  };
  return {
    owner: (_turn, signal) => codingApprovalOwner(signal),
    sandbox: (task) => resolveSandbox(task, true),
    inspectSandbox: (task) => resolveSandbox(task, false),
  };
}
