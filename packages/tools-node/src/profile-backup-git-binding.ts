import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodingAssetManifest, CodingWorktree } from '@runnets/domain';
import type { CodingGitAdministration } from './coding-git-administration.js';
import { privateAssetDirectory } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
const bad = (): never => {
  throw Error('invalid_profile_git_binding');
};
/** Archived absolute names are compared lexically only; no original path is consulted. */
export function verifyProfileGitBinding(
  tree: CodingWorktree,
  manifest: CodingAssetManifest | undefined,
  archive: string,
  administration?: CodingGitAdministration,
): void {
  let pointer: string | null = null;
  if (manifest) {
    const entry = manifest.entries.find((e) => e.path === '.git');
    if (entry?.kind !== 'file' || entry.bytes > 4096) return bad();
    const fd = privateAssetDirectory(join(archive, 'blobs'));
    try {
      pointer = readDesktopArchiveFile(fd, entry.sha256, 4096, entry.sha256).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (!pointer.startsWith('gitdir: ') || !pointer.endsWith('\n')) return bad();
    const adminPath = resolve(tree.root, pointer.slice(8, -1));
    if (
      dirname(adminPath) !== join(tree.gitCommonDir, 'worktrees') ||
      !new RegExp('^' + basename(tree.root) + '(?:[1-9][0-9]{0,8})?$').test(basename(adminPath))
    )
      return bad();
  }
  if (!administration) return;
  const files = new Map(
    administration.files.map((f) => [f.name, Buffer.from(f.body, 'base64').toString('utf8')]),
  );
  if (administration.branch !== null && administration.branch !== tree.baseCommit) return bad();
  if ((files.get('root/.git') ?? null) !== pointer) return bad();
  if (administration.admin === null) {
    if (pointer !== null) return bad();
    return;
  }
  const adminPath = join(tree.gitCommonDir, 'worktrees', administration.admin);
  if (
    !new RegExp('^' + basename(tree.root) + '(?:[1-9][0-9]{0,8})?$').test(administration.admin) ||
    (pointer !== null && resolve(tree.root, pointer.slice(8, -1)) !== adminPath) ||
    files.get('admin/HEAD') !== 'ref: refs/heads/' + tree.branch + '\n' ||
    resolve(adminPath, files.get('admin/commondir')?.trim() ?? '') !== tree.gitCommonDir ||
    files.get('admin/gitdir')?.trim() !== join(tree.root, '.git')
  )
    return bad();
}
