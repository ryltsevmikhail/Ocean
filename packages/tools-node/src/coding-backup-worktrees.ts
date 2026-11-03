import {
  preflightCodingWorktrees,
  preflightCodingWorktreeTree,
} from './coding-worktree-preflight.js';
import * as fs from 'node:fs';
import { holdPartialCodingGit, type CodingPartialGitCapture } from './coding-git-partial.js';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CodingBackupInventory, CodingWorktree } from '@runnets/domain';
import {
  captureCodingAssetTree,
  captureAssetTreeAt,
  codingAssetIdentity,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { captureCodingGitObjects, type CodingGitObjectCapture } from './coding-git-backup.js';
import { assetDirectoryFlags, checkAssetPath } from './coding-asset-io.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface WorktreeReference {
  readonly taskId: string;
  readonly slot: string;
  readonly state: CodingWorktree['state'];
}
export type CodingWorktreeAssetRecord = WorktreeReference &
  (
    | {
        readonly presence: 'partial';
        readonly treeHash: string | null;
        readonly indexSha256: string | null;
        readonly packSha256: string;
        readonly administrationHash: string;
      }
    | {
        readonly presence: 'captured';
        readonly treeHash: string;
        readonly indexSha256: string;
        readonly packSha256: string;
      }
  );
export interface CodingWorktreeAssetCatalog {
  readonly format: 1;
  readonly inventoryHash: string;
  readonly worktrees: readonly CodingWorktreeAssetRecord[];
  readonly hash: string;
}
export interface CodingWorktreeAssetInput {
  readonly slot: string;
  readonly worktree: CodingWorktree;
  readonly capture: CodingAssetCapture;
  readonly git: CodingGitObjectCapture;
}
export interface CodingPartialWorktreeAssetInput {
  readonly slot: string;
  readonly worktree: CodingWorktree;
  readonly capture: CodingAssetCapture | null;
  readonly git: CodingPartialGitCapture;
}
function present(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
/** Worktree subgraph only; the caller must hold profile maintenance ownership until publication. */
export async function captureCodingWorktreeAssets(
  frozen: CodingBackupInventory,
  managedDirectory: string,
  consume: (input: CodingWorktreeAssetInput) => Promise<void>,
  consumePartial?: (input: CodingPartialWorktreeAssetInput) => Promise<void>,
): Promise<CodingWorktreeAssetCatalog> {
  const inventory = structuredClone(frozen),
    { hash: inventoryHash, ...inventoryBody } = inventory;
  if (
    inventory.format !== 1 ||
    hash(inventoryBody) !== inventoryHash ||
    inventory.worktrees.length > 1000 ||
    inventory.tasks.length > 1000 ||
    resolve(managedDirectory) !== managedDirectory
  )
    throw Error('invalid_coding_inventory');
  const tasks = new Map(inventory.tasks.map((task) => [task.id, task]));
  const plans = inventory.worktrees.map((worktree) => {
    const task = tasks.get(worktree.taskId);
    if (!task) throw Error('invalid_coding_inventory');
    const slot = hash([task.ownerId, task.projectRoot, task.id]);
    if (
      worktree.root !== join(managedDirectory, slot) ||
      worktree.branch !== 'codex/ocean/' + slot ||
      task.worktreeRoot !== worktree.root ||
      task.workspaceId !== worktree.workspaceId ||
      task.projectRoot !== worktree.projectRoot ||
      task.baseCommit !== worktree.baseCommit ||
      task.ownerId !== worktree.lease.ownerId ||
      worktree.lease.projectRoot !== worktree.root ||
      worktree.lease.taskId !== task.id ||
      !['preparing', 'ready', 'uncertain'].includes(worktree.state)
    )
      throw Error('invalid_coding_inventory');
    return { worktree, slot };
  });
  if (
    new Set(plans.map(({ slot }) => slot)).size !== plans.length ||
    tasks.size !== inventory.tasks.length ||
    inventory.tasks.some(
      (task) =>
        task.worktreeRoot !== null && !plans.some(({ worktree }) => worktree.taskId === task.id),
    )
  )
    throw Error('invalid_coding_inventory');
  const records: CodingWorktreeAssetRecord[] = [];
  const observed = new Map<
    string,
    {
      sourceStateHash: string;
      treeHash: string;
      index: string;
      pack: string;
      limits: CodingAssetCapture['limits'];
    }
  >();
  const partials = new Map<string, Omit<ReturnType<typeof holdPartialCodingGit>, 'capture'>>();
  let bytes = 0,
    logicalBytes = 0,
    entries = 0,
    objects = 0;
  let managed: number | undefined;
  try {
    const managedPresent = plans.length > 0 && present(managedDirectory);
    if (managedPresent) {
      if (fs.realpathSync(managedDirectory) !== managedDirectory)
        throw Error('invalid_coding_asset_root');
      managed = fs.openSync(managedDirectory, assetDirectoryFlags);
      const stat = fs.fstatSync(managed);
      if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw Error('invalid_coding_asset_root');
      checkAssetPath(managed, managedDirectory);
    }
    const managedState =
      managed === undefined ? '' : codingAssetIdentity(fs.fstatSync(managed, { bigint: true }));
    if (!consumePartial && plans.some(({ worktree }) => worktree.state !== 'ready'))
      throw Error('partial_coding_consumer_required');
    preflightCodingWorktrees(
      plans.map(({ worktree }) => worktree),
      managedDirectory,
    );
    for (const { worktree, slot } of plans) {
      if (worktree.state !== 'ready') {
        if (!consumePartial) throw Error('partial_coding_consumer_required');
        const held = holdPartialCodingGit(worktree, managedDirectory, (fd) =>
          preflightCodingWorktreeTree(worktree, fd),
        );
        const { capture: git, ...guard } = held;
        partials.set(slot, guard);
        const capture =
          git.administration.root === 'absent'
            ? null
            : captureAssetTreeAt(
                worktree.root,
                {
                  bytes: Math.min(2147483648 - bytes, 2147483648 - logicalBytes),
                  entries: 100000 - entries,
                },
                'coding-worktree',
                held.rootFd!,
                () => held.verifyBinding(),
              );
        held.verifyBinding();
        const metadataBytes = Buffer.byteLength(JSON.stringify(git.administration));
        bytes +=
          (capture?.manifest.bytes ?? 0) +
          (git.index?.length ?? 0) +
          git.pack.length +
          metadataBytes;
        logicalBytes +=
          (capture?.manifest.bytes ?? 0) +
          (git.index?.length ?? 0) +
          git.objectBytes +
          metadataBytes;
        entries += (capture?.manifest.entries.length ?? 0) + git.administration.files.length + 4;
        objects += git.objectIds.length;
        if (bytes > 2147483648 || logicalBytes > 2147483648 || entries > 100000 || objects > 100000)
          throw Error('coding_asset_limit');
        if (capture)
          observed.set(slot, {
            sourceStateHash: capture.sourceStateHash,
            treeHash: capture.manifest.hash,
            index: '',
            pack: '',
            limits: { ...capture.limits },
          });
        records.push({
          taskId: worktree.taskId,
          slot,
          state: worktree.state,
          presence: 'partial',
          treeHash: capture?.manifest.hash ?? null,
          indexSha256: git.indexSha256,
          packSha256: git.packSha256,
          administrationHash: git.administration.hash,
        });
        await consumePartial({ slot, worktree: structuredClone(worktree), capture, git });
        continue;
      }
      if (!present(worktree.root)) throw Error('missing_coding_worktree');
      const stat = fs.lstatSync(worktree.root);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw Error('invalid_coding_asset_root');
      const git = captureCodingGitObjects(worktree, (fd) =>
        preflightCodingWorktreeTree(worktree, fd),
      );
      const capture = captureCodingAssetTree(
        worktree.root,
        {
          bytes: Math.min(2147483648 - bytes, 2147483648 - logicalBytes),
          entries: 100000 - entries,
        },
        'coding-worktree',
      );
      bytes += capture.manifest.bytes + git.index.length + git.pack.length;
      logicalBytes += capture.manifest.bytes + git.index.length + git.objectBytes;
      entries += capture.manifest.entries.length;
      objects += git.objectIds.length;
      if (bytes > 2147483648 || logicalBytes > 2147483648 || entries > 100000 || objects > 100000)
        throw Error('coding_asset_limit');
      observed.set(slot, {
        sourceStateHash: capture.sourceStateHash,
        treeHash: capture.manifest.hash,
        index: git.indexSha256,
        pack: git.packSha256,
        limits: { ...capture.limits },
      });
      records.push({
        taskId: worktree.taskId,
        slot,
        state: worktree.state,
        presence: 'captured',
        treeHash: capture.manifest.hash,
        indexSha256: git.indexSha256,
        packSha256: git.packSha256,
      });
      await consume({ slot, worktree: structuredClone(worktree), capture, git });
    }
    // Recheck ALL earlier roots after the last consumer, not only the last copied one.
    for (const held of partials.values()) held.verifyBinding();
    preflightCodingWorktrees(
      plans.map(({ worktree }) => worktree),
      managedDirectory,
    );
    for (const { worktree, slot } of plans) {
      partials.get(slot)?.verify();
      const expected = observed.get(slot);
      if (!expected) {
        if (present(worktree.root)) throw Error('stale_coding_asset');
        continue;
      }
      const current = captureCodingAssetTree(worktree.root, expected.limits, 'coding-worktree');
      if (
        current.sourceStateHash !== expected.sourceStateHash ||
        current.manifest.hash !== expected.treeHash
      )
        throw Error('stale_coding_asset');
      if (partials.has(slot)) {
        partials.get(slot)!.verify();
        continue;
      }
      const git = captureCodingGitObjects(worktree, (fd) =>
        preflightCodingWorktreeTree(worktree, fd),
      );
      if (git.indexSha256 !== expected.index || git.packSha256 !== expected.pack)
        throw Error('stale_coding_asset');
    }
    if (plans.length > 0 && present(managedDirectory) !== managedPresent)
      throw Error('stale_coding_asset');
    if (managed !== undefined) {
      checkAssetPath(managed, managedDirectory);
      if (codingAssetIdentity(fs.fstatSync(managed, { bigint: true })) !== managedState)
        throw Error('stale_coding_asset');
    }
    const body = { format: 1 as const, inventoryHash, worktrees: records };
    return { ...body, hash: hash(body) };
  } finally {
    for (const held of partials.values()) held.close();
    if (managed !== undefined) fs.closeSync(managed);
  }
}
