import { createHash } from 'node:crypto';
import type { CodingAssetManifest, CodingBackupInventory } from '@runnets/domain';
import { validCodingBackupPolicy } from '@runnets/domain';
import { basename, join, relative } from 'node:path';
import {
  dependencyFail,
  dependencyHash,
  parseFrozenCodingProjects,
} from './coding-dependency-config.js';
import type { CodingDependencyCatalog } from './coding-dependency-graph.js';
import { dependencyVirtualTree } from './coding-dependency-mapping.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
/** Reconstruct every portable binding; original absolute paths are compared only as strings. */
export function verifyDependencyCatalog(
  inventory: CodingBackupInventory,
  catalog: CodingDependencyCatalog,
  manifests: ReadonlyMap<string, CodingAssetManifest>,
): void {
  const { hash, ...body } = catalog,
    { hash: inventoryHash, ...inventoryBody } = inventory;
  if (
    catalog.format !== 1 ||
    hash !== dependencyHash(body) ||
    inventory.format !== 1 ||
    inventoryHash !== dependencyHash(inventoryBody) ||
    inventoryHash !== catalog.inventoryHash ||
    inventory.tasks.length > 1000 ||
    catalog.tasks.length !== inventory.tasks.length ||
    new Set(inventory.tasks.map((t) => t.id)).size !== inventory.tasks.length
  )
    return dependencyFail();
  const config = catalog.configuration;
  if (!config || !['present', 'absent'].includes(config.presence)) return dependencyFail();
  if (config.presence === 'absent' && (config.bytes !== null || config.sha256 !== null))
    return dependencyFail();
  const bytes =
    config.presence === 'present' && typeof config.bytes === 'string'
      ? Buffer.from(config.bytes, 'base64')
      : null;
  if (
    config.presence === 'present' &&
    (!bytes ||
      bytes.toString('base64') !== config.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== config.sha256)
  )
    return dependencyFail();
  const projects = (bytes ? parseFrozenCodingProjects(bytes) : []).map((p) => ({
    ...p,
    selection: inventory.tasks.some((t) => t.projectRoot === p.root) ? 'selected' : 'metadata-only',
  }));
  if (dependencyHash(projects) !== dependencyHash(catalog.projects)) return dependencyFail();
  const used = new Set<string>();
  for (const [index, task] of inventory.tasks.entries()) {
    const actual = catalog.tasks[index]!,
      project = projects.find((p) => p.root === task.projectRoot);
    if (
      !project ||
      project.root !== task.projectRoot ||
      !validCodingBackupPolicy(task.policyVersion, task.policy) ||
      dependencyHash(task.policy.testPresets) !== dependencyHash(project.testPresets) ||
      actual.taskId !== task.id ||
      actual.projectId !== project.id ||
      actual.policyHash !== dependencyHash([task.policyVersion, task.policy])
    )
      return dependencyFail();
    const mappings = project.mounts.map((m) => {
      if (
        m.target !== '/toolchain/pnpm/bin/pnpm' &&
        (!project.dependencyProjectRoot ||
          !/^\/workspace\/(?:[A-Za-z0-9_-]+\/)*node_modules$/.test(m.target) ||
          m.source !== join(project.dependencyProjectRoot, relative('/workspace', m.target)))
      )
        return dependencyFail();
      const slot = dependencyHash([m.source, m.target]),
        manifest = manifests.get(slot);
      if (!manifest) return dependencyFail();
      used.add(slot);
      const file = m.target === '/toolchain/pnpm/bin/pnpm' ? basename(m.source) : null;
      if (file !== null) {
        if (
          JSON.stringify(manifest.selectedFiles) !== JSON.stringify([file]) ||
          manifest.entries.length !== 2
        )
          return dependencyFail();
        const entry = manifest.entries[1]!;
        if (entry.kind !== 'file' || !(entry.mode & 0o111)) return dependencyFail();
      } else if (manifest.selectedFiles) return dependencyFail();
      return { slot, source: m.source, target: m.target, file, manifestHash: manifest.hash };
    });
    if (
      new Set(mappings.map((m) => m.target)).size !== mappings.length ||
      dependencyHash(mappings) !== dependencyHash(actual.mappings)
    )
      return dependencyFail();
    if (actual.treeSelection !== (actual.treeHash === null ? 'not-supplied' : 'captured'))
      return dependencyFail();
    let tree: CodingAssetManifest | undefined;
    if (actual.treeHash !== null) {
      if (!task.worktreeRoot || !/^[a-f0-9]{64}$/.test(actual.treeHash)) return dependencyFail();
      const name = 'tree-' + actual.treeHash;
      tree = manifests.get(name);
      used.add(name);
      if (!tree || tree.hash !== actual.treeHash || tree.selectedFiles) return dependencyFail();
    }
    const virtual = dependencyVirtualTree(mappings, manifests, tree);
    if (
      virtual.hash !== actual.virtualHash ||
      dependencyHash(validateCodingAssetLinks(virtual)) !== dependencyHash(actual.links)
    )
      return dependencyFail();
  }
  if (used.size !== manifests.size || [...manifests.keys()].some((k) => !used.has(k)))
    return dependencyFail();
}
