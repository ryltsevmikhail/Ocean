import * as fs from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import type { CodingAssetManifest, CodingBackupInventory } from '@runnets/domain';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
import {
  assetNames,
  assetDirectoryFlags,
  checkAssetPath,
  privateAssetDirectory,
  privateAssetChild,
  readAssetBlob,
  assetFdPath,
} from './coding-asset-io.js';
import { codingAssetIdentity } from './coding-asset-state.js';
import {
  captureCodingDependencyAssets,
  type CodingDependencyTree,
  type CodingDependencyCatalog,
} from './coding-dependency-graph.js';
import {
  dependencyFail,
  dependencyHash,
  holdCodingConfiguration,
} from './coding-dependency-config.js';
import { verifyDependencyCatalog } from './coding-dependency-verification.js';
import { dependencyVirtualTree } from './coding-dependency-mapping.js';
import { DependencyBudget } from './coding-dependency-budget.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
function writePrivate(path: string, value: unknown) {
  const fd = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function readPrivate(root: number, name: string, limit: number): unknown {
  const path = join(assetFdPath(root), name),
    stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.size > limit) return dependencyFail();
  const chunks: Buffer[] = [];
  readAssetBlob(root, name, stat.size, (b) => chunks.push(Buffer.from(b)));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function createOutput(path: string): number {
  if (resolve(path) !== path || fs.realpathSync(dirname(path)) !== dirname(path))
    return dependencyFail();
  const parent = fs.openSync(dirname(path), assetDirectoryFlags);
  let root: number | undefined;
  try {
    checkAssetPath(parent, dirname(path));
    fs.mkdirSync(join(assetFdPath(parent), basename(path)), { mode: 0o700 });
    root = privateAssetChild(parent, basename(path), path);
    if (assetNames(root, 1).length) return dependencyFail();
    writePrivate(join(assetFdPath(root), '.incomplete'), { format: 1 });
    fs.fsyncSync(root);
    checkAssetPath(parent, dirname(path));
    fs.fsyncSync(parent);
    return root;
  } catch (error) {
    if (root !== undefined) fs.closeSync(root);
    throw error;
  } finally {
    fs.closeSync(parent);
  }
}
/** Private composable subgraph archive, never the public full-profile format. Failure retains evidence. */
export async function archiveCodingDependencyAssets(
  inventory: CodingBackupInventory,
  profile: string,
  trees: readonly CodingDependencyTree[],
  destination: string,
): Promise<CodingDependencyCatalog> {
  const frozen = structuredClone(inventory),
    configuration = holdCodingConfiguration(profile);
  try {
    const sources = [
      ...frozen.tasks.flatMap((t) => [t.projectRoot, ...(t.worktreeRoot ? [t.worktreeRoot] : [])]),
      ...trees.map((t) => t.capture.root),
      ...configuration.projects.flatMap((p) => [
        p.root,
        ...(p.dependencyProjectRoot ? [p.dependencyProjectRoot] : []),
        ...p.mounts.map((m) =>
          m.target === '/toolchain/pnpm/bin/pnpm' ? dirname(m.source) : m.source,
        ),
      ]),
    ];
    if (sources.some((source) => destination === source || destination.startsWith(source + '/')))
      return dependencyFail();
    configuration.verify();
  } finally {
    configuration.close();
  }
  const root = createOutput(destination);
  try {
    const archive = ({
      slot,
      capture,
    }: {
      slot: string;
      capture: CodingDependencyTree['capture'];
    }) => {
      archiveCodingAssetTree(capture, join(destination, slot));
      return Promise.resolve();
    };
    const catalog = await captureCodingDependencyAssets(frozen, profile, trees, archive, archive);
    checkAssetPath(root, destination);
    writePrivate(join(assetFdPath(root), 'inventory.json'), frozen);
    writePrivate(join(assetFdPath(root), 'catalog.json'), catalog);
    fs.fsyncSync(root);
    // Verify while incomplete before publication; public verifier refuses the marker.
    verifyArchive(destination, true);
    fs.unlinkSync(join(assetFdPath(root), '.incomplete'));
    fs.fsyncSync(root);
    return verifyCodingDependencyArchive(destination);
  } finally {
    fs.closeSync(root);
  }
}
function verifyArchive(directory: string, incomplete = false) {
  const root = privateAssetDirectory(directory);
  try {
    const state = codingAssetIdentity(fs.fstatSync(root, { bigint: true }));
    const catalog = readPrivate(root, 'catalog.json', 16777216) as CodingDependencyCatalog;
    const inventory = readPrivate(root, 'inventory.json', 16777216) as CodingBackupInventory;
    const names = assetNames(root, 100003),
      manifests = new Map<string, CodingAssetManifest>();
    const budget = new DependencyBudget();
    budget.metadata([catalog, inventory]);
    for (const name of names) {
      if (['catalog.json', 'inventory.json', ...(incomplete ? ['.incomplete'] : [])].includes(name))
        continue;
      if (!/^(?:tree-)?[a-f0-9]{64}$/.test(name)) return dependencyFail();
      const manifest = verifyCodingAssetArchive(join(directory, name));
      budget.manifest(manifest);
      manifests.set(name, manifest);
    }
    verifyDependencyCatalog(inventory, catalog, manifests);
    for (const [name, manifest] of manifests)
      if (verifyCodingAssetArchive(join(directory, name)).hash !== manifest.hash)
        throw Error('stale_coding_asset');
    if (
      dependencyHash(readPrivate(root, 'catalog.json', 16777216)) !== dependencyHash(catalog) ||
      dependencyHash(readPrivate(root, 'inventory.json', 16777216)) !== dependencyHash(inventory)
    )
      throw Error('stale_coding_asset');
    checkAssetPath(root, directory);
    if (state !== codingAssetIdentity(fs.fstatSync(root, { bigint: true })))
      throw Error('stale_coding_asset');
    return { catalog, manifests };
  } finally {
    fs.closeSync(root);
  }
}
export function verifyCodingDependencyArchive(directory: string): CodingDependencyCatalog {
  return verifyArchive(directory).catalog;
}
/** One independently verified virtual task under private quarantine, with unchanged relative links. */
export function restoreCodingDependencyTask(
  archive: string,
  taskId: string,
  destination: string,
): CodingAssetManifest {
  const { catalog, manifests } = verifyArchive(archive),
    task = catalog.tasks.find((t) => t.taskId === taskId);
  if (!task) return dependencyFail();
  const manifest = dependencyVirtualTree(
    task.mappings,
    manifests,
    task.treeHash ? manifests.get('tree-' + task.treeHash) : undefined,
  );
  const root = createOutput(destination);
  try {
    const combined = join(destination, 'archive');
    fs.mkdirSync(combined, { mode: 0o700 });
    fs.mkdirSync(join(combined, 'blobs'), { mode: 0o700 });
    const required = new Map(
      manifest.entries.flatMap((e) => (e.kind === 'file' ? [[e.sha256, e.bytes] as const] : [])),
    );
    for (const [name, sourceManifest] of manifests) {
      for (const entry of sourceManifest.entries) {
        if (entry.kind !== 'file' || !required.has(entry.sha256)) continue;
        const source = privateAssetDirectory(join(archive, name));
        let blobs: number | undefined;
        try {
          blobs = privateAssetChild(source, 'blobs', join(archive, name, 'blobs'));
          const fd = fs.openSync(join(combined, 'blobs', entry.sha256), 'wx', 0o600);
          try {
            const digest = readAssetBlob(blobs, entry.sha256, entry.bytes, (chunk) => {
              let offset = 0;
              while (offset < chunk.length) {
                const n = fs.writeSync(fd, chunk, offset, chunk.length - offset);
                if (!n) return dependencyFail();
                offset += n;
              }
            });
            if (digest !== entry.sha256) return dependencyFail();
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        } finally {
          if (blobs !== undefined) fs.closeSync(blobs);
          fs.closeSync(source);
        }
        required.delete(entry.sha256);
      }
    }
    if (required.size) return dependencyFail();
    writePrivate(join(combined, 'manifest.json'), manifest);
    restoreCodingAssetTree(combined, join(destination, 'materialized'));
    if (dependencyHash(verifyCodingDependencyArchive(archive)) !== dependencyHash(catalog))
      throw Error('stale_coding_asset');
    checkAssetPath(root, destination);
    fs.unlinkSync(join(assetFdPath(root), '.incomplete'));
    fs.fsyncSync(root);
    return manifest;
  } finally {
    fs.closeSync(root);
  }
}
