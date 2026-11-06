import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { assertCodingInspection } from './coding-git.js';
import type { ToolDispatchGuard, ChangesetPort } from '@runnets/application';
import {
  CodingArtifactError,
  type CodingTask,
  type WorktreeBinding,
  type Changeset,
  type CodingFileContent,
  type CodingFileChange,
} from '@runnets/domain';
import { type CodingFile } from './coding-file.js';
import { codingDiff } from './coding-diff.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { codingBaseFiles, codingWorkingTree, codingManifest } from './coding-working-tree.js';
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
function text(file: CodingFile | undefined): CodingFileContent | null {
  if (!file) return null;
  if (file.body.length > 131072 || file.body.includes(0))
    throw new CodingArtifactError(
      file.body.length > 131072 ? 'changeset_limit' : 'unsupported_file',
    );
  try {
    return {
      mode: file.mode,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.body),
      sha256: hash(file.body),
    };
  } catch (error) {
    if (error instanceof CodingArtifactError) throw error;
    throw new CodingArtifactError('unsupported_file');
  }
}
export class GitCodingSnapshots implements ChangesetPort {
  readonly #betweenScans: (() => void | Promise<void>) | undefined;
  constructor(options: { readonly betweenScans?: () => void | Promise<void> } = {}) {
    this.#betweenScans = options.betweenScans;
  }
  async capture(
    task: CodingTask,
    binding: WorktreeBinding,
    guard?: ToolDispatchGuard,
  ): Promise<Changeset> {
    assertCodingInspection(guard);
    const worktrees = new GitCodingWorktrees(dirname(binding.root));
    await worktrees.verify(task, binding);
    assertCodingInspection(guard);
    const base = await codingBaseFiles(binding.root, task.baseCommit, guard);
    assertCodingInspection(guard);
    const after = await codingWorkingTree(binding.root, base, guard),
      beforeTreeHash = codingManifest(base),
      afterTreeHash = codingManifest(after);
    await this.#betweenScans?.();
    assertCodingInspection(guard);
    const confirm = await codingWorkingTree(binding.root, base, guard);
    await worktrees.verify(task, binding);
    if (codingManifest(confirm) !== afterTreeHash) throw new CodingArtifactError('stale_capture');
    const paths = [...new Set([...base.keys(), ...after.keys()])].sort(),
      files: CodingFileChange[] = [];
    let size = 0;
    for (const path of paths) {
      const old = base.get(path),
        next = after.get(path);
      if (old && next && old.mode === next.mode && old.body.equals(next.body)) continue;
      const before = text(old),
        changed = text(next);
      size += (old?.body.length ?? 0) + (next?.body.length ?? 0);
      if (size > 2097152) throw new CodingArtifactError('changeset_limit');
      files.push({ path, before, after: changed });
    }
    const diff = codingDiff(files);
    if (Buffer.byteLength(diff) > 4194304) throw new CodingArtifactError('changeset_limit');
    const payload = {
      taskId: task.id,
      baseCommit: task.baseCommit,
      beforeTreeHash,
      afterTreeHash,
      files,
      diff,
    };
    const digest = hash(JSON.stringify(payload));
    return { id: digest, hash: digest, ...payload };
  }
}
