import { verifyProfileGitBinding } from './profile-backup-git-binding.js';
import { chargeProfileManifest } from './profile-backup-accounting.js';
import { profileArchiveContext } from './profile-archive-context.js';
import { ProfileBackupBudget } from './profile-backup-session.js';
import { validateProfileCatalogShape } from './profile-backup-schema.js';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { CodingAssetManifest, ProfileBackupAssetIdentity } from '@runnets/domain';
import { assetDirectoryFlags, assetNames, privateAssetDirectory } from './coding-asset-io.js';
import { scanAssetSource } from './coding-asset-source.js';
import { CODING_ASSET_LIMITS, type CodingAssetCapture } from './coding-asset-state.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { profileHash } from './profile-backup-output.js';
import type { ProfileBackupAssets, ProfileBackupAssetCatalog } from './profile-backup-types.js';
import { verifyCodingAssetArchive } from './coding-asset-archive.js';
import { verifyCodingDependencyArchive } from './coding-dependency-archive.js';
import { verifyDesktopAssetArchive } from './desktop-assets.js';
import { verifyPluginBackupFiles } from './plugin-backup-files.js';
import { verifyPartialCodingGitArchive } from './coding-git-partial-archive.js';
import { verifyProfileGit } from './profile-backup-git.js';
import { verifyProfileRecovery } from './profile-backup-recovery.js';
const bad = (): never => {
  throw Error('invalid_profile_backup');
};
const identity = (catalog: ProfileBackupAssetCatalog): ProfileBackupAssetIdentity => ({
  catalog: catalog.hash,
  codingInventory: catalog.inventory.hash,
  desktopInventory: profileHash(catalog.desktopInventory),
  worktrees: catalog.worktrees.hash,
  recovery: catalog.recovery.hash,
  dependencies: catalog.dependencies.hash,
  desktop: catalog.desktop?.hash ?? null,
  ...(catalog.plugins ? { plugins: catalog.plugins.hash } : {}),
});
function names(path: string): string[] {
  const fd = privateAssetDirectory(path);
  try {
    return assetNames(fd, 100001);
  } finally {
    fs.closeSync(fd);
  }
}
/** Retains original archive metadata and hashes through the final materialization consumer. */
export function withProfileArchive<T>(
  directory: string,
  consume: (original: CodingAssetCapture) => T,
): T {
  const fd = fs.openSync(directory, assetDirectoryFlags);
  try {
    const parent = profileArchiveContext.getStore(),
      budget = parent?.budget ?? new ProfileBackupBudget();
    const covered = parent?.roots.some(
      (r) => directory === r.capture.root || directory.startsWith(r.capture.root + '/'),
    );
    const metadata = scanAssetSource(
      directory,
      CODING_ASSET_LIMITS,
      'all',
      undefined,
      true,
      fd,
      undefined,
      undefined,
      covered ? undefined : (values) => budget.charge('archive:' + directory, values),
    );
    for (const entry of metadata.manifest.entries)
      if (
        (entry.kind !== 'file' && entry.kind !== 'directory') ||
        entry.mode !== (entry.kind === 'file' ? 0o600 : 0o700)
      )
        return bad();
    const expected = { entries: new Map(metadata.sourceEntries), mount: metadata.sourceMount },
      metadataFiles = metadata.manifest.entries.filter(
        (entry) => entry.kind === 'file' && entry.path.endsWith('.json'),
      );
    // Admit the whole JSON body set before even the first streaming hash read.
    // Identity+mount keys are shared by outer-envelope and nested archive checks.
    for (const entry of metadataFiles) {
      if (entry.kind !== 'file' || entry.bytes > 33554432) return bad();
      budget.charge('archive-json:' + expected.mount + ':' + expected.entries.get(entry.path), {
        metadata: entry.bytes,
      });
    }
    const original = scanAssetSource(directory, CODING_ASSET_LIMITS, 'all', expected, false, fd);
    const result = profileArchiveContext.run(
      {
        budget,
        roots: [...(parent?.roots ?? []), { capture: original, states: expected.entries }],
      },
      () => {
        for (const entry of original.manifest.entries)
          if (entry.kind === 'file' && entry.path.endsWith('.json')) {
            const bytes = readDesktopArchiveFile(fd, entry.path, 33554432, entry.sha256);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (JSON.stringify(JSON.parse(text)) !== text) return bad();
          }
        return consume(original);
      },
    );
    const afterMetadata = scanAssetSource(
      directory,
      CODING_ASSET_LIMITS,
      'all',
      expected,
      true,
      fd,
    );
    if (afterMetadata.sourceStateHash !== metadata.sourceStateHash)
      throw Error('stale_coding_asset');
    const after = scanAssetSource(directory, CODING_ASSET_LIMITS, 'all', expected, false, fd);
    if (after.manifest.hash !== original.manifest.hash) throw Error('stale_coding_asset');
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
/** Independent verification touches only archive-owned paths; original paths remain inert strings. */
export function verifyProfileAssetArchive(
  directory: string,
  expected: ProfileBackupAssetIdentity,
  incomplete = false,
  consume?: (assets: ProfileBackupAssets) => void,
): ProfileBackupAssets {
  return withProfileArchive(directory, () => {
    const budget = profileArchiveContext.getStore()!.budget;
    const root = privateAssetDirectory(directory);
    let catalog: ProfileBackupAssetCatalog;
    try {
      catalog = JSON.parse(
        readDesktopArchiveFile(root, 'catalog.json', 33554432).toString('utf8'),
      ) as ProfileBackupAssetCatalog;
    } finally {
      fs.closeSync(root);
    }
    validateProfileCatalogShape(catalog);
    const { hash, ...body } = catalog;
    const catalogKeys =
      catalog.plugins === undefined
        ? 'dependencies,desktop,desktopInventory,format,git,hash,inventory,recovery,worktrees'
        : 'dependencies,desktop,desktopInventory,format,git,hash,inventory,plugins,recovery,worktrees';
    if (
      Object.keys(catalog).sort().join() !== catalogKeys ||
      catalog.format !== 2 ||
      hash !== profileHash(body) ||
      profileHash(identity(catalog)) !== profileHash(expected) ||
      catalog.git.length !== catalog.inventory.worktrees.length ||
      catalog.worktrees.inventoryHash !== catalog.inventory.hash ||
      catalog.worktrees.worktrees.length !== catalog.inventory.worktrees.length
    )
      return bad();
    const { hash: worktreeHash, ...worktreeBody } = catalog.worktrees;
    if (profileHash(worktreeBody) !== worktreeHash || catalog.worktrees.format !== 1) return bad();
    if (
      names(directory).join() !==
      [
        ...(incomplete ? ['.incomplete'] : []),
        'catalog.json',
        'dependencies',
        ...(catalog.desktop ? ['desktop'] : []),
        'git',
        ...(catalog.plugins ? ['plugins'] : []),
        'recovery',
        'worktrees',
      ]
        .sort()
        .join()
    )
      return bad();
    const slots = new Set<string>(),
      trees = new Map<string, CodingAssetManifest>();
    for (const [index, tree] of catalog.inventory.worktrees.entries()) {
      const task = catalog.inventory.tasks.find((t) => t.id === tree.taskId),
        record = catalog.worktrees.worktrees[index]!,
        slot = task && profileHash([task.ownerId, task.projectRoot, task.id]),
        git = catalog.git[index];
      if (
        !task ||
        !slot ||
        slots.has(slot) ||
        tree.root !== join(dirname(tree.root), slot) ||
        tree.branch !== 'codex/ocean/' + slot ||
        task.worktreeRoot !== tree.root ||
        tree.baseCommit !== task.baseCommit ||
        tree.workspaceId !== task.workspaceId ||
        tree.projectRoot !== task.projectRoot ||
        tree.lease.ownerId !== task.ownerId ||
        record.taskId !== task.id ||
        record.slot !== slot ||
        record.state !== tree.state ||
        !git ||
        git.slot !== slot ||
        !['ready', 'partial'].includes(git.kind)
      )
        return bad();
      slots.add(slot);
      if (
        tree.state === 'ready'
          ? record.presence !== 'captured' || git.kind !== 'ready'
          : record.presence !== 'partial' || git.kind !== 'partial'
      )
        return bad();
      if (record.treeHash !== null) {
        const manifest = verifyCodingAssetArchive(join(directory, 'worktrees', slot));
        if (manifest.hash !== record.treeHash || manifest.selectedFiles) return bad();
        chargeProfileManifest(budget, join(directory, 'worktrees', slot), manifest);
        trees.set(slot, manifest);
      } else if (tree.state === 'ready') return bad();
      const objects =
        git.kind === 'ready'
          ? verifyProfileGit(join(directory, 'git', slot), git.sha256, false, budget)
          : verifyPartialCodingGitArchive(join(directory, 'git', slot), git.sha256, budget);
      if (
        objects.baseCommit !== tree.baseCommit ||
        objects.packSha256 !== record.packSha256 ||
        objects.indexSha256 !== record.indexSha256 ||
        (record.presence === 'partial' &&
          (!('administration' in objects) ||
            objects.administration.hash !== record.administrationHash ||
            (objects.administration.root === 'present') !== (record.treeHash !== null)))
      )
        return bad();
      verifyProfileGitBinding(
        tree,
        trees.get(slot),
        join(directory, 'worktrees', slot),
        'administration' in objects ? objects.administration : undefined,
      );
    }
    if (
      names(join(directory, 'git')).join() !== [...slots].sort().join() ||
      names(join(directory, 'worktrees')).join() !== [...trees.keys()].sort().join()
    )
      return bad();
    const dependencies = verifyCodingDependencyArchive(join(directory, 'dependencies'));
    if (
      profileHash(dependencies) !== profileHash(catalog.dependencies) ||
      dependencies.inventoryHash !== catalog.inventory.hash
    )
      return bad();
    for (const task of catalog.inventory.tasks) {
      const worktree = catalog.worktrees.worktrees.find((t) => t.taskId === task.id),
        dependency = dependencies.tasks.find((t) => t.taskId === task.id);
      if (
        !dependency ||
        (worktree?.treeHash ?? null) !== dependency.treeHash ||
        (worktree?.presence === 'captured' && dependency.treeSelection !== 'captured')
      )
        return bad();
    }
    const recovery = new Map<string, CodingAssetManifest>();
    for (const name of names(join(directory, 'recovery'))) {
      if (!/^(scoped|legacy)-[a-f0-9]{64}$/.test(name)) return bad();
      const manifest = verifyCodingAssetArchive(join(directory, 'recovery', name));
      chargeProfileManifest(budget, join(directory, 'recovery', name), manifest);
      recovery.set(name, manifest);
    }
    verifyProfileRecovery(
      join(directory, 'recovery'),
      catalog.inventory,
      catalog.recovery,
      recovery,
    );
    if (catalog.desktop) {
      const desktop = verifyDesktopAssetArchive(join(directory, 'desktop'));
      chargeProfileManifest(budget, join(directory, 'desktop'), desktop.manifest);
      if (
        profileHash(desktop) !== profileHash(catalog.desktop) ||
        profileHash(desktop.inventory) !== profileHash(catalog.desktopInventory)
      )
        return bad();
    }
    if (catalog.plugins) {
      verifyPluginBackupFiles(join(directory, 'plugins'), catalog.plugins);
    }
    if (!catalog.desktop)
      if (
        catalog.desktopInventory.binding ||
        catalog.desktopInventory.messages.length ||
        catalog.desktopInventory.operations.length ||
        catalog.desktopInventory.uploads.length
      )
        return bad();
    const result = { catalog, identity: identity(catalog) };
    consume?.(structuredClone(result));
    return result;
  });
}

export function verifyProfileBackupAssets(
  directory: string,
  expected: ProfileBackupAssetIdentity,
): ProfileBackupAssets {
  return verifyProfileAssetArchive(directory, expected);
}
