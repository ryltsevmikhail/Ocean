import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, open, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  CodingArtifactError,
  type CodingTask,
  type WorktreePlan,
  type WorktreeBinding,
} from '@runnets/domain';
import type { WorktreePort } from '@runnets/application';
import { GitCodingProject } from './coding-project.js';
import { codingGit } from './coding-git.js';
import { codingTree, FILE_BYTES, TREE_BYTES } from './coding-tree.js';
import { blockedName } from './backend.js';
/** Creates metadata without Git checkout, then materializes raw blobs without hooks/filters. */
export class GitCodingWorktrees implements WorktreePort {
  readonly #directory: string;
  constructor(directory = join(homedir(), '.local/state/ocean-worktrees')) {
    this.#directory = resolve(directory);
  }
  async plan(task: CodingTask): Promise<WorktreePlan> {
    const id = createHash('sha256')
      .update(JSON.stringify([task.lease.ownerId, task.projectRoot, task.id]))
      .digest('hex');
    const common = await codingGit(task.projectRoot, ['rev-parse', '--git-common-dir']);
    return {
      root: join(this.#directory, id),
      branch: 'codex/ocean/' + id,
      gitCommonDir: await realpath(resolve(task.projectRoot, common.toString().trim())),
    };
  }
  async preflight(task: CodingTask): Promise<void> {
    await this.#base(task);
  }
  async #base(task: CodingTask) {
    const entries = await codingTree(task.projectRoot, task.baseCommit);
    if (entries.some((e) => e.path.split('/').some(blockedName)))
      throw new CodingArtifactError('unsupported_file');
    // Validate all blobs/limits before creating Git administration state.
    let bytes = 0;
    const blobs = new Map<string, Buffer>();
    for (const e of entries) {
      const body = await codingGit(task.projectRoot, ['cat-file', 'blob', e.objectId], FILE_BYTES);
      bytes += body.length;
      if (bytes > TREE_BYTES) throw new CodingArtifactError('changeset_limit');
      blobs.set(e.path, body);
    }
    return { entries, blobs };
  }
  async create(task: CodingTask, plan: WorktreePlan): Promise<WorktreeBinding> {
    if (JSON.stringify(await this.plan(task)) !== JSON.stringify(plan))
      throw new CodingArtifactError('worktree_unavailable');
    const project = await new GitCodingProject().inspect(task.projectRoot);
    if (!project.clean || project.baseCommit !== task.baseCommit)
      throw new CodingArtifactError('worktree_unavailable');
    const { entries, blobs } = await this.#base(task);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#directory);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077 ||
      (await realpath(this.#directory)) !== this.#directory
    )
      throw new CodingArtifactError('worktree_unavailable');
    try {
      await lstat(plan.root);
      throw new CodingArtifactError('worktree_unavailable');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await codingGit(task.projectRoot, [
      'worktree',
      'add',
      '--no-checkout',
      '-b',
      plan.branch,
      plan.root,
      task.baseCommit,
    ]);
    await chmod(plan.root, 0o700);
    for (const entry of entries) {
      const path = join(plan.root, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(blobs.get(entry.path)!);
        await file.chmod(entry.mode === '100755' ? 0o755 : 0o644);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const binding = {
      ...plan,
      taskId: task.id,
      projectRoot: task.projectRoot,
      baseCommit: task.baseCommit,
    };
    await codingGit(plan.root, ['read-tree', task.baseCommit]);
    const directories = new Set([
      this.#directory,
      plan.root,
      ...entries.map((e) => dirname(join(plan.root, e.path))),
    ]);
    for (const directory of directories) {
      const fd = await open(directory, 'r');
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await this.verify(task, binding);
    return binding;
  }
  async verify(task: CodingTask, binding: WorktreeBinding): Promise<void> {
    if (
      task.id !== binding.taskId ||
      task.projectRoot !== binding.projectRoot ||
      task.baseCommit !== binding.baseCommit ||
      JSON.stringify(await this.plan(task)) !==
        JSON.stringify({
          root: binding.root,
          branch: binding.branch,
          gitCommonDir: binding.gitCommonDir,
        }) ||
      (await realpath(binding.root)) !== binding.root
    )
      throw new CodingArtifactError('worktree_unavailable');
    const head = (await codingGit(binding.root, ['rev-parse', 'HEAD'])).toString().trim();
    const branch = (await codingGit(binding.root, ['symbolic-ref', '--quiet', 'HEAD']))
      .toString()
      .trim();
    const common = (await codingGit(binding.root, ['rev-parse', '--git-common-dir']))
      .toString()
      .trim();
    if (
      head !== task.baseCommit ||
      branch !== 'refs/heads/' + binding.branch ||
      (await realpath(resolve(binding.root, common))) !== binding.gitCommonDir
    )
      throw new CodingArtifactError('worktree_unavailable');
  }
}
