import { basename } from 'node:path';
import type { CodingAssetManifest, CodingBackupInventory } from '@runnets/domain';
import { dependencyHash, type FrozenCodingProject } from './coding-dependency-config.js';
import { dependencyVirtualTree } from './coding-dependency-mapping.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
import type { CodingDependencyCatalog } from './coding-dependency-types.js';
/** Metadata and body passes produce identically sized records; all link text is already known. */
export function dependencyTaskRecord(
  task: CodingBackupInventory['tasks'][number],
  project: FrozenCodingProject,
  tree: CodingAssetManifest | undefined,
  manifests: ReadonlyMap<string, CodingAssetManifest>,
  metadataOnly = false,
): CodingDependencyCatalog['tasks'][number] {
  const mappings = project.mounts.map((m) => {
    const slot = dependencyHash([m.source, m.target]);
    return {
      slot,
      source: m.source,
      target: m.target,
      file: m.target === '/toolchain/pnpm/bin/pnpm' ? basename(m.source) : null,
      manifestHash: manifests.get(slot)!.hash,
    };
  });
  const virtual = dependencyVirtualTree(mappings, manifests, tree, metadataOnly);
  return {
    taskId: task.id,
    projectId: project.id,
    policyHash: dependencyHash([task.policyVersion, task.policy]),
    treeHash: tree?.hash ?? null,
    treeSelection: tree ? 'captured' : 'not-supplied',
    mappings,
    virtualHash: virtual.hash,
    links: validateCodingAssetLinks(virtual),
  };
}
