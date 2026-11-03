import * as fs from 'node:fs';
import { join } from 'node:path';
import type {
  ProfileBackupSource,
  ProfileBackupAssets,
  ProfileBackupAssetCatalog,
} from './profile-backup-types.js';
import { ProfileBackupOutput, profileHash, freezeProfileValue } from './profile-backup-output.js';
import { profileBackupSession, type ProfileBackupLimits } from './profile-backup-session.js';
import {
  consumePreparedProfileBackup,
  type PreparedProfileBackup,
} from './profile-backup-prepare.js';
import { captureCodingWorktreeAssets } from './coding-backup-worktrees.js';
import { captureCodingRecoveryAssets } from './coding-recovery-graph.js';
import { archiveCodingDependencyAssets } from './coding-dependency-archive.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { archivePartialCodingGit } from './coding-git-partial-archive.js';
import { archiveProfileGit } from './profile-backup-git.js';
import { captureDesktopAssets, archiveDesktopAssets } from './desktop-assets.js';
import type { CodingDependencyTree } from './coding-dependency-types.js';
import { verifyProfileAssetArchive } from './profile-backup-verify.js';
export {
  type ProfileBackupSource,
  type ProfileBackupAssets,
  type ProfileBackupAssetCatalog,
} from './profile-backup-types.js';
export { type ProfileBackupLimits } from './profile-backup-session.js';
export interface ProfileBackupCapture extends ProfileBackupAssets {
  verify(): void;
  publish(finalCheck?: () => void, terminalProof?: () => void): void;
  close(): void;
}
export function profileBackupIdentity(catalog: ProfileBackupAssetCatalog) {
  return {
    catalog: catalog.hash,
    codingInventory: catalog.inventory.hash,
    desktopInventory: profileHash(catalog.desktopInventory),
    worktrees: catalog.worktrees.hash,
    recovery: catalog.recovery.hash,
    dependencies: catalog.dependencies.hash,
    desktop: catalog.desktop?.hash ?? null,
  };
}
/** One ownership-held graph. The callback remains inside the original source-observation lifetime. */
export async function captureProfileBackupAssets(
  input: ProfileBackupSource | PreparedProfileBackup,
  destination: string,
  consume?: (assets: ProfileBackupAssets) => Promise<void>,
  limits?: Partial<ProfileBackupLimits>,
): Promise<ProfileBackupCapture> {
  const { source, session, close } = consumePreparedProfileBackup(input, destination, limits);
  let output: ProfileBackupOutput | undefined;
  try {
    return await profileBackupSession.run(session, async () => {
      output = new ProfileBackupOutput(destination);
      for (const name of ['worktrees', 'git', 'recovery'])
        fs.mkdirSync(join(destination, name), { mode: 0o700 });
      const trees: CodingDependencyTree[] = [],
        git: ProfileBackupAssetCatalog['git'][number][] = [];
      const worktrees = await captureCodingWorktreeAssets(
        source.inventory,
        source.managed,
        ({ slot, worktree, capture, git: objects }) => {
          trees.push({ taskId: worktree.taskId, capture });
          archiveCodingAssetTree(capture, join(destination, 'worktrees', slot));
          git.push({
            slot,
            kind: 'ready',
            sha256: archiveProfileGit(objects, join(destination, 'git', slot)),
          });
          return Promise.resolve();
        },
        ({ slot, worktree, capture, git: objects }) => {
          if (capture) {
            trees.push({ taskId: worktree.taskId, capture });
            archiveCodingAssetTree(capture, join(destination, 'worktrees', slot));
          }
          git.push({
            slot,
            kind: 'partial',
            sha256: archivePartialCodingGit(objects, join(destination, 'git', slot)),
          });
          return Promise.resolve();
        },
      );
      const recovery = await captureCodingRecoveryAssets(
        source.inventory,
        source.managed,
        ({ kind, slot, capture }) => {
          archiveCodingAssetTree(capture, join(destination, 'recovery', kind + '-' + slot));
          return Promise.resolve();
        },
      );
      const dependencies = await archiveCodingDependencyAssets(
        source.inventory,
        source.profile,
        trees,
        join(destination, 'dependencies'),
      );
      const desktop = source.desktop.binding
        ? archiveDesktopAssets(captureDesktopAssets(source.desktop), join(destination, 'desktop'))
        : null;
      const body = {
        format: 2 as const,
        inventory: source.inventory,
        desktopInventory: source.desktop,
        worktrees,
        recovery,
        dependencies,
        desktop,
        git,
      };
      session.budget.charge('catalog', { metadata: Buffer.byteLength(JSON.stringify(body)) + 80 });
      const catalog = { ...body, hash: profileHash(body) };
      output.write('catalog.json', catalog);
      const assets = freezeProfileValue({ catalog, identity: profileBackupIdentity(catalog) });
      verifyProfileAssetArchive(destination, assets.identity, true);
      session.verify();
      // Parent publication preparation runs while all original private witnesses remain live.
      if (consume) await consume(assets);
      verifyProfileAssetArchive(destination, assets.identity, true);
      session.verify();
      let published = false,
        closed = false;
      const verify = () =>
        profileBackupSession.run(session, () => {
          if (closed) throw Error('closed_profile_backup');
          verifyProfileAssetArchive(destination, assets.identity, !published);
          session.verify();
        });
      return {
        ...assets,
        verify,
        publish: (finalCheck?: () => void, terminalProof?: () => void) => {
          verify();
          finalCheck?.();
          // The copied-database byte reader is also a consumer of the held graph.
          profileBackupSession.run(session, () => session.verify());
          // The host supplies a sterile read-only original-byte proof, not another consumer.
          terminalProof?.();
          session.checkMetadata();
          output!.publish();
          published = true;
        },
        close: () => {
          if (!closed) {
            closed = true;
            output!.close();
            close();
          }
        },
      };
    });
  } catch (error) {
    output?.close();
    close();
    throw error;
  }
}
