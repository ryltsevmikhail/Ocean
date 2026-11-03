import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodingTask, WorktreeBinding, ProfileRebindPlan } from '@runnets/domain';
import { codingGit } from './coding-git.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { rebindSync, rebindWrite } from './profile-rebind-io.js';
import { scanAssetSource } from './coding-asset-source.js';
import { CODING_ASSET_LIMITS } from './coding-asset-state.js';

/** The old pointer is never opened as Git authority. Only this attempt's new admin is rewritten. */
export async function attachRebindGit(
  task: CodingTask,
  selection: ProfileRebindPlan,
): Promise<void> {
  const plan = selection.worktree,
    output = selection.assetDirectory,
    temporary = selection.gitTemporaryRoot;
  if (
    fs.lstatSync(temporary, { throwIfNoEntry: false }) ||
    fs.lstatSync(selection.gitAdministration, { throwIfNoEntry: false })
  )
    throw Error('rebind_output_exists');
  await codingGit(task.projectRoot, [
    'worktree',
    'add',
    '--no-checkout',
    '-b',
    plan.branch,
    temporary,
    task.baseCommit,
  ]);
  const pointer = join(temporary, '.git');
  const fd = fs.openSync(pointer, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw Error('rebind_git_mismatch');
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (!text.startsWith('gitdir: ') || !text.endsWith('\n')) throw Error('rebind_git_mismatch');
  const admin = resolve(temporary, text.slice(8).trim());
  if (
    admin !== selection.gitAdministration ||
    dirname(admin) !== join(plan.gitCommonDir, 'worktrees') ||
    fs.realpathSync(admin) !== admin ||
    fs.readFileSync(join(admin, 'gitdir'), 'utf8') !== pointer + '\n'
  )
    throw Error('rebind_git_mismatch');
  const oldPointer = join(plan.root, '.git');
  const old = fs.lstatSync(oldPointer);
  if (!old.isFile() || old.nlink !== 1) throw Error('rebind_git_mismatch');
  rebindWrite(join(plan.root, '.git.new'), text);
  rebindWrite(join(admin, 'gitdir.new'), join(plan.root, '.git') + '\n');
  fs.renameSync(join(admin, 'gitdir.new'), join(admin, 'gitdir'));
  rebindSync(admin);
  fs.renameSync(join(plan.root, '.git.new'), oldPointer);
  rebindSync(plan.root);
  fs.unlinkSync(pointer);
  fs.rmdirSync(temporary);
  rebindSync(output);
  await codingGit(plan.root, ['read-tree', task.baseCommit]);
  // The prospective 16 MiB reservation includes the fresh index/admin; overflow stays held.
  scanAssetSource(admin, { ...CODING_ASSET_LIMITS, bytes: 16777216, entries: 10000 }, 'all');
  const binding: WorktreeBinding = {
    ...plan,
    taskId: task.id,
    projectRoot: task.projectRoot,
    baseCommit: task.baseCommit,
  };
  await new GitCodingWorktrees(dirname(plan.root)).verify(task, binding);
  rebindSync(admin);
  rebindSync(dirname(admin));
  rebindSync(dirname(plan.root));
  if (basename(plan.root) === 'workspace') throw Error('rebind_git_mismatch');
}
