import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { ChangesetPort } from '@runnets/application';
import {
  CodingArtifactError,
  type CodingTask,
  type WorktreeBinding,
  type Changeset,
  type CodingFileContent,
  type CodingFileChange,
} from '@runnets/domain';
import { codingGit, codingPath, codingText } from './coding-git.js';
import { codingTree, TREE_BYTES, TREE_FILES, FILE_BYTES } from './coding-tree.js';
import { codingFile, type CodingFile } from './coding-file.js';
import { codingDiff } from './coding-diff.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { blockedName } from './backend.js';
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const forbidden = (path: string) => path.split('/').some(blockedName);
function manifest(files: ReadonlyMap<string, CodingFile>): string {
  return hash(
    JSON.stringify(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, f]) => [p, f.mode, hash(f.body)]),
    ),
  );
}
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
  async #scan(
    binding: WorktreeBinding,
    base: ReadonlyMap<string, CodingFile>,
  ): Promise<Map<string, CodingFile>> {
    const cached = codingText(await codingGit(binding.root, ['ls-files', '-z', '--cached']))
      .split('\0')
      .filter(Boolean);
    if (cached.some(forbidden)) throw new CodingArtifactError('unsupported_file');
    const untracked = codingText(
      await codingGit(binding.root, ['ls-files', '-z', '--others', '--exclude-standard']),
    )
      .split('\0')
      .filter(Boolean)
      .filter((p) => !forbidden(p));
    const paths = [...new Set([...base.keys(), ...cached, ...untracked])].sort();
    if (paths.length > TREE_FILES) throw new CodingArtifactError('changeset_limit');
    const result = new Map<string, CodingFile>();
    let bytes = 0;
    for (const path of paths) {
      codingPath(path);
      if (forbidden(path)) throw new CodingArtifactError('unsupported_file');
      const file = await codingFile(binding.root, path);
      if (file) {
        bytes += file.body.length;
        if (bytes > TREE_BYTES) throw new CodingArtifactError('changeset_limit');
        result.set(path, file);
      }
    }
    return result;
  }
  async capture(task: CodingTask, binding: WorktreeBinding): Promise<Changeset> {
    const worktrees = new GitCodingWorktrees(dirname(binding.root));
    await worktrees.verify(task, binding);
    const entries = await codingTree(binding.root, task.baseCommit),
      base = new Map<string, CodingFile>();
    let total = 0;
    for (const entry of entries) {
      if (forbidden(entry.path)) throw new CodingArtifactError('unsupported_file');
      const body = await codingGit(binding.root, ['cat-file', 'blob', entry.objectId], FILE_BYTES);
      total += body.length;
      if (total > TREE_BYTES) throw new CodingArtifactError('changeset_limit');
      base.set(entry.path, { body, mode: entry.mode });
    }
    const after = await this.#scan(binding, base),
      beforeTreeHash = manifest(base),
      afterTreeHash = manifest(after);
    await this.#betweenScans?.();
    const confirm = await this.#scan(binding, base);
    await worktrees.verify(task, binding);
    if (manifest(confirm) !== afterTreeHash) throw new CodingArtifactError('stale_capture');
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
