import type { ToolDispatchGuard } from '@runnets/application';
import { CodingArtifactError, type CodingFileMode } from '@runnets/domain';
import { codingGit, codingPath, codingText } from './coding-git.js';
export interface CodingTreeEntry {
  readonly path: string;
  readonly mode: CodingFileMode;
  readonly objectId: string;
}
export const TREE_BYTES = 33554432,
  FILE_BYTES = 8388608,
  TREE_FILES = 1000;
export async function codingTree(
  root: string,
  commit: string,
  guard?: ToolDispatchGuard,
): Promise<readonly CodingTreeEntry[]> {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new CodingArtifactError('worktree_unavailable');
  const raw = codingText(
    await codingGit(root, ['ls-tree', '-rz', '--full-tree', commit], undefined, guard),
  );
  const entries = raw
    .split('\0')
    .filter(Boolean)
    .map((line): CodingTreeEntry => {
      const tab = line.indexOf('\t'),
        header = line.slice(0, tab).split(' '),
        path = line.slice(tab + 1);
      codingPath(path);
      const mode = header[0],
        objectId = header[2];
      if (
        (mode !== '100644' && mode !== '100755') ||
        header[1] !== 'blob' ||
        typeof objectId !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(objectId)
      )
        throw new CodingArtifactError('unsupported_file');
      return { path, mode, objectId };
    });
  if (entries.length > TREE_FILES) throw new CodingArtifactError('changeset_limit');
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
