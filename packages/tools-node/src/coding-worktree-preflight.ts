import * as fs from 'node:fs';
import type { CodingWorktree } from '@runnets/domain';
import { CODING_ASSET_LIMITS } from './coding-asset-state.js';
import { scanAssetSource } from './coding-asset-source.js';
import { preflightCodingGitObjects } from './coding-git-backup.js';
import { preflightPartialCodingGit } from './coding-git-partial.js';
export function preflightCodingWorktreeTree(worktree: CodingWorktree, fd: number): void {
  scanAssetSource(worktree.root, CODING_ASSET_LIMITS, 'coding-worktree', undefined, true, fd);
}
/** Every binding and protected namespace precedes ANY selected tree/object body read. */
export function preflightCodingWorktrees(
  worktrees: readonly CodingWorktree[],
  managed: string,
): void {
  for (const worktree of worktrees) {
    const preflight = (fd: number) => preflightCodingWorktreeTree(worktree, fd);
    if (worktree.state !== 'ready') preflightPartialCodingGit(worktree, managed, preflight);
    else {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(worktree.root);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          throw Error('missing_coding_worktree');
        throw error;
      }
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw Error('invalid_coding_asset_root');
      preflightCodingGitObjects(worktree, preflight);
    }
  }
}
