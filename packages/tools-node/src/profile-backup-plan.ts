import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CodingBackupInventory, DesktopAssetInventory } from '@runnets/domain';
import type { ProfileBackupSession } from './profile-backup-session.js';
import { assetDirectoryFlags, checkAssetPath, assetNames } from './coding-asset-io.js';
import { scanAssetSource } from './coding-asset-source.js';
import {
  CODING_ASSET_LIMITS,
  codingAssetIdentity,
  codingAssetMount,
} from './coding-asset-state.js';
import type { CodingAssetPolicy } from './coding-asset-policy.js';
import { planAssetSelection } from './coding-asset-selection.js';
import { holdCodingConfiguration } from './coding-dependency-config.js';
import { preflightCodingWorktrees } from './coding-worktree-preflight.js';
import { planRecoveryGraph } from './coding-recovery-plan.js';
import { codingApplyRecoverySlot } from './coding-apply-scope.js';
import { desktopAliasGuards } from './desktop-preparation-alias.js';
import { desktopRootIdentity } from './desktop-assets.js';
export function prepareProfileBackupSources(
  session: ProfileBackupSession,
  coding: CodingBackupInventory,
  desktop: DesktopAssetInventory,
  profile: string,
  managed: string,
  destination: string,
  inert?: { readonly roots: readonly string[]; readonly gitCommonDirs: readonly string[] },
): void {
  const configuration = holdCodingConfiguration(profile),
    selected = new Set<string>();
  session.retain('configuration', JSON.stringify(configuration.configuration), {
    metadata: () => configuration.verify(true),
    bytes: configuration.verify,
    close: configuration.close,
  });
  session.budget.charge('inventory', {
    metadata: Buffer.byteLength(
      JSON.stringify([coding, desktop, configuration.configuration, configuration.projects]),
    ),
  });
  const selectedProjects = configuration.projects.filter((project) =>
    coding.tasks.some((task) => task.projectRoot === project.root),
  );
  const copies = new Map<string, Set<string>>(),
    executables = new Map<string, Set<string>>();
  for (const project of selectedProjects)
    for (const mount of project.mounts) {
      if (mount.target === '/toolchain/pnpm/bin/pnpm') {
        const path = dirname(mount.source),
          files = executables.get(path) ?? new Set<string>();
        files.add(basename(mount.source));
        executables.set(path, files);
      } else {
        const targets = copies.get(mount.source) ?? new Set<string>();
        targets.add(mount.target);
        copies.set(mount.source, targets);
      }
    }
  const root = (path: string, policy: CodingAssetPolicy, files?: string[]) => {
    if (destination === path || destination.startsWith(path + '/'))
      throw Error('invalid_profile_backup_destination');
    if (selected.has(path)) return;
    selected.add(path);
    const fd = fs.openSync(path, assetDirectoryFlags);
    const occurrences = coding.worktrees.some((tree) => tree.root === path)
      ? 2
      : (copies.get(path)?.size ?? 1);
    try {
      const options =
          policy === 'desktop'
            ? { bytes: 134217728, entries: 10000, depth: 3 }
            : CODING_ASSET_LIMITS,
        selection = files && planAssetSelection(files, options),
        candidates = new Set<string>(),
        metadata = scanAssetSource(
          path,
          options,
          policy,
          undefined,
          true,
          fd,
          selection,
          ['desktop', 'coding-recovery-v2'].includes(policy) ? { candidates } : undefined,
          (values) =>
            session.budget.charge('source:' + path, {
              stored: values.stored * occurrences,
              logical: (values.logical + values.stored) * occurrences,
              entries: values.entries * occurrences,
              metadata: values.metadata * occurrences,
            }),
        );
      if (policy === 'desktop') desktopAliasGuards(desktop, metadata, candidates);
      session.plan(metadata, {
        metadata: () => {
          const current = scanAssetSource(
            path,
            options,
            policy,
            { entries: new Map(metadata.sourceEntries), mount: metadata.sourceMount },
            true,
            fd,
            selection,
            ['desktop', 'coding-recovery-v2'].includes(policy)
              ? { candidates: new Set() }
              : undefined,
          );
          if (current.sourceStateHash !== metadata.sourceStateHash)
            throw Error('stale_coding_asset');
        },
        bytes: () => {},
        close: () => fs.closeSync(fd),
      });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  const optionalRoot = (path: string, policy: CodingAssetPolicy) => {
    if (fs.lstatSync(path, { throwIfNoEntry: false })) {
      root(path, policy);
      return;
    }
    let parentPath = dirname(path);
    while (!fs.lstatSync(parentPath, { throwIfNoEntry: false })) parentPath = dirname(parentPath);
    const fd = fs.openSync(parentPath, assetDirectoryFlags),
      identity = codingAssetIdentity(fs.fstatSync(fd, { bigint: true })),
      mount = codingAssetMount(fd);
    session.retain('absence:' + path, identity, {
      metadata: () => {
        checkAssetPath(fd, parentPath);
        if (
          codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== identity ||
          codingAssetMount(fd) !== mount ||
          fs.lstatSync(path, { throwIfNoEntry: false })
        )
          throw Error('stale_coding_asset');
      },
      bytes: () => {},
      close: () => fs.closeSync(fd),
    });
  };
  for (const project of [...coding.tasks.map((task) => task.projectRoot), ...(inert?.roots ?? [])])
    if (destination === project || destination.startsWith(project + '/'))
      throw Error('invalid_profile_backup_destination');
  for (const gitCommonDir of [
    ...coding.worktrees.map((tree) => tree.gitCommonDir),
    ...(inert?.gitCommonDirs ?? []),
  ])
    if (destination === gitCommonDir || destination.startsWith(gitCommonDir + '/'))
      throw Error('invalid_profile_backup_destination');
  for (const tree of coding.worktrees) {
    if (tree.state === 'ready') root(tree.root, 'coding-worktree');
    else optionalRoot(tree.root, 'coding-worktree');
  }
  for (const project of selectedProjects) {
    for (const mount of project.mounts)
      if (mount.target === '/toolchain/pnpm/bin/pnpm')
        root(
          dirname(mount.source),
          copies.has(dirname(mount.source)) ? 'coding-dependency' : 'coding-worktree',
          copies.has(dirname(mount.source))
            ? undefined
            : [...executables.get(dirname(mount.source))!],
        );
      else root(mount.source, 'coding-dependency');
  }
  for (const plan of planRecoveryGraph(coding, managed)) {
    optionalRoot(
      join(
        plan.tree.gitCommonDir,
        'ocean-apply-recovery-v2',
        codingApplyRecoverySlot(plan.tree.projectRoot, plan.context),
      ),
      'coding-recovery-v2',
    );
    if (
      plan.application.recoveryProtocol === null &&
      plan.application.files.some((file) => file.status !== 'pending')
    )
      optionalRoot(join(plan.tree.gitCommonDir, 'ocean-apply-recovery'), 'coding-recovery');
  }
  if (desktop.binding) {
    if (desktopRootIdentity(desktop.binding.root) !== desktop.binding.identity)
      throw Error('desktop_binding_mismatch');
    root(desktop.binding.root, 'desktop');
  } else if (desktop.messages.length || desktop.operations.length || desktop.uploads.length)
    throw Error('desktop_assets_unbound');
  preflightCodingWorktrees(coding.worktrees, managed);
  // Keep the profile namespace original as well; the destination is required outside it.
  if (destination === profile || destination.startsWith(profile + '/'))
    throw Error('invalid_profile_backup_destination');
  const profileFd = fs.openSync(profile, assetDirectoryFlags);
  try {
    let nameBytes = 0,
      nameCount = 0;
    const names = assetNames(profileFd, session.budget.limits.entries, (name) => {
      nameBytes += Buffer.byteLength(name) + 1;
      session.budget.charge('profile-names', { metadata: nameBytes, entries: ++nameCount });
    }).join('\0');
    session.budget.charge('profile-names', {
      metadata: Buffer.byteLength(names),
      entries: names ? names.split('\0').length : 0,
    });
    session.retain('profile-namespace', names, {
      metadata: () => {
        checkAssetPath(profileFd, profile);
        if (assetNames(profileFd, session.budget.limits.entries).join('\0') !== names)
          throw Error('stale_coding_asset');
      },
      bytes: () => {},
      close: () => fs.closeSync(profileFd),
    });
  } catch (error) {
    fs.closeSync(profileFd);
    throw error;
  }
}
