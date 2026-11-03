import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import type { CodingAssetEntry, CodingAssetManifest, ProfileRebindPlan } from '@runnets/domain';
import { scanAssetSource } from './coding-asset-source.js';
import { CODING_ASSET_LIMITS } from './coding-asset-state.js';
import { profileHash } from './profile-backup-output.js';

function comparable(entries: readonly CodingAssetEntry[]) {
  const groups = new Map<string, string[]>();
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'hardlink') continue;
    const target = entry.kind === 'file' ? entry.path : entry.target;
    const group = groups.get(target) ?? [];
    group.push(entry.path);
    groups.set(target, group);
  }
  const result: unknown[] = entries.filter((e) => e.kind !== 'file' && e.kind !== 'hardlink');
  for (const [target, paths] of groups) {
    const file = byPath.get(target);
    if (!file || file.kind !== 'file') throw Error('rebind_tree_changed');
    const sorted = paths.sort();
    result.push({ ...file, path: sorted[0], links: sorted });
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
export function verifyReboundTree(plan: ProfileRebindPlan, expected: CodingAssetManifest): void {
  const slot = basename(plan.worktree.root);
  const alias = join(plan.managedDirectory, 'workspace');
  if (
    !fs.lstatSync(alias).isSymbolicLink() ||
    fs.readlinkSync(alias) !== slot ||
    fs.realpathSync(alias) !== plan.worktree.root
  )
    throw Error('rebind_tree_changed');
  const capture = scanAssetSource(plan.managedDirectory, CODING_ASSET_LIMITS, 'all');
  const rename = (path: string) =>
    path === slot
      ? 'workspace'
      : path.startsWith(slot + '/')
        ? 'workspace' + path.slice(slot.length)
        : path;
  const normalized = capture.manifest.entries
    .filter((e) => e.path !== 'workspace')
    .map((entry) =>
      entry.kind === 'hardlink'
        ? { ...entry, path: rename(entry.path), target: rename(entry.target) }
        : { ...entry, path: rename(entry.path) },
    );
  const withoutGit = (entries: readonly CodingAssetEntry[]) =>
    entries.filter((e) => e.path !== 'workspace/.git');
  if (
    profileHash(comparable(withoutGit(normalized))) !==
    profileHash(comparable(withoutGit(expected.entries)))
  )
    throw Error('rebind_tree_changed');
}
