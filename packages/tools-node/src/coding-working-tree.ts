import type { ToolDispatchGuard } from '@runnets/application';
import { createHash } from 'node:crypto';
import { CodingArtifactError } from '@runnets/domain';
import { assertCodingInspection, codingGit, codingPath, codingText } from './coding-git.js';
import { codingTree, TREE_BYTES, TREE_FILES, FILE_BYTES } from './coding-tree.js';
import { codingFile, type CodingFile } from './coding-file.js';
import { blockedName } from './backend.js';
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const forbidden = (path: string) => path.split('/').some(blockedName);
export function codingManifest(files: ReadonlyMap<string, CodingFile>): string {
  return hash(
    JSON.stringify(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, f]) => [p, f.mode, hash(f.body)]),
    ),
  );
}
export async function codingWorkingTree(
  root: string,
  base: ReadonlyMap<string, CodingFile>,
  guard?: ToolDispatchGuard,
): Promise<Map<string, CodingFile>> {
  const cached = codingText(await codingGit(root, ['ls-files', '-z', '--cached'], undefined, guard))
    .split('\0')
    .filter(Boolean);
  if (cached.some(forbidden)) throw new CodingArtifactError('unsupported_file');
  const untracked = codingText(
    await codingGit(root, ['ls-files', '-z', '--others', '--exclude-standard'], undefined, guard),
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
    assertCodingInspection(guard);
    const file = await codingFile(root, path, guard);
    if (file) {
      bytes += file.body.length;
      if (bytes > TREE_BYTES) throw new CodingArtifactError('changeset_limit');
      result.set(path, file);
    }
  }
  return result;
}
export async function codingBaseFiles(
  root: string,
  commit: string,
  guard?: ToolDispatchGuard,
): Promise<Map<string, CodingFile>> {
  const entries = await codingTree(root, commit, guard),
    base = new Map<string, CodingFile>();
  let total = 0;
  for (const entry of entries) {
    if (forbidden(entry.path)) throw new CodingArtifactError('unsupported_file');
    const body = await codingGit(root, ['cat-file', 'blob', entry.objectId], FILE_BYTES, guard);
    total += body.length;
    if (total > TREE_BYTES) throw new CodingArtifactError('changeset_limit');
    base.set(entry.path, { body, mode: entry.mode });
  }
  return base;
}
