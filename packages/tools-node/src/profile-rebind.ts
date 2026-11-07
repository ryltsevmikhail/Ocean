import { join } from 'node:path';
import * as fs from 'node:fs';
import type { ProfileRebindFiles } from '@runnets/application';
import { inspectRebind } from './profile-rebind-inspect.js';
import { prepareRebind } from './profile-rebind-prepare.js';
import { restoredRebindSource, type RestoreSnapshotReader } from './profile-rebind-source.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { verifyReboundTree } from './profile-rebind-tree.js';
import { privateAssetDirectory } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { desktopBindingMatches, withDesktopRoot } from './desktop-root.js';
import { scanAssetSource } from './coding-asset-source.js';
import { CODING_ASSET_LIMITS } from './coding-asset-state.js';
import { profileHash } from './profile-backup-output.js';
import type { CodingTask, RestoreOrigin } from '@runnets/domain';
import { observeRebindFiles } from './profile-rebind-observe.js';

/** Composed by the trusted host with the public, read-only SQLite snapshot adapter. */
export class RestoredProfileFiles implements ProfileRebindFiles {
  readonly profile: string;
  readonly readSnapshot: RestoreSnapshotReader;
  constructor(profile: string, readSnapshot: RestoreSnapshotReader) {
    this.profile = profile;
    this.readSnapshot = readSnapshot;
  }
  inspect(input: Parameters<ProfileRebindFiles['inspect']>[0]) {
    return inspectRebind(this.profile, this.readSnapshot, input);
  }
  diagnose(origin: RestoreOrigin, task: CodingTask, projectRoot: string) {
    const source = restoredRebindSource(this.profile, origin, task, this.readSnapshot);
    return observeRebindFiles(projectRoot, source.catalog.inventory, task.id);
  }
  prepare(record: Parameters<ProfileRebindFiles['prepare']>[0]) {
    return prepareRebind(this.profile, this.readSnapshot, record);
  }
  async verify(
    preview: Parameters<ProfileRebindFiles['verify']>[0],
    result: Parameters<ProfileRebindFiles['verify']>[1],
  ): Promise<void> {
    const source = restoredRebindSource(
      this.profile,
      preview.origin,
      preview.originalTask,
      this.readSnapshot,
    );
    if (source.witness !== preview.plan.evidenceWitness) throw Error('stale_coding_asset');
    verifyReboundTree(preview.plan, source.manifest);
    await new GitCodingWorktrees(preview.plan.managedDirectory).verify(
      result.task,
      result.worktree,
    );
    const root = privateAssetDirectory(this.profile);
    try {
      if (
        readDesktopArchiveFile(root, 'coding-projects.json', 1048576).toString('utf8') !==
        JSON.stringify([preview.plan.registration])
      )
        throw Error('rebind_registration_changed');
    } finally {
      fs.closeSync(root);
    }
    if (source.catalog.desktop) {
      const binding = result.desktop,
        expected = preview.plan.desktop,
        archived = source.catalog.desktop.inventory.binding;
      if (
        !binding ||
        !expected ||
        expected.profileId !== preview.origin.profileId ||
        expected.epochId !== preview.epochId ||
        expected.root !== join(this.profile, 'desktop-' + preview.epochId, 'tree') ||
        expected.identity !== null ||
        expected.archiveHash !== source.catalog.desktop.hash ||
        binding.profileId !== preview.origin.profileId ||
        binding.root !== expected.root ||
        !desktopBindingMatches(binding) ||
        binding.originalRoot !== archived?.originalRoot ||
        binding.identity === archived?.identity ||
        withDesktopRoot(binding, (held) =>
          profileHash(
            scanAssetSource(binding.root, CODING_ASSET_LIMITS, 'desktop', undefined, false, held.fd)
              .manifest,
          ),
        ) !== profileHash(source.catalog.desktop.manifest)
      )
        throw Error('rebind_desktop_changed');
    } else if (preview.plan.desktop !== null || result.desktop !== null) {
      throw Error('rebind_desktop_changed');
    }
    if (join(this.profile, 'rebind-' + preview.epochId) !== preview.plan.assetDirectory)
      throw Error('invalid_rebind_identity');
  }
}
