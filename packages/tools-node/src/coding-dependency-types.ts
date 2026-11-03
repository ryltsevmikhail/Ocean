import type { CodingAssetCapture } from './coding-asset-scan.js';
import type { FrozenCodingConfiguration, FrozenCodingProject } from './coding-dependency-config.js';
import type { CodingDependencyMapping } from './coding-dependency-mapping.js';
import type { validateCodingAssetLinks } from './coding-asset-links.js';
export interface CodingDependencyTree {
  readonly taskId: string;
  readonly capture: CodingAssetCapture;
}
export interface CodingDependencyInput {
  readonly slot: string;
  readonly capture: CodingAssetCapture;
}
export interface CodingDependencyCatalog {
  readonly format: 1;
  readonly inventoryHash: string;
  readonly configuration: FrozenCodingConfiguration;
  readonly projects: readonly (FrozenCodingProject & {
    readonly selection: 'selected' | 'metadata-only';
  })[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly projectId: string;
    readonly policyHash: string;
    readonly treeHash: string | null;
    readonly treeSelection: 'captured' | 'not-supplied';
    readonly mappings: readonly CodingDependencyMapping[];
    readonly virtualHash: string;
    readonly links: ReturnType<typeof validateCodingAssetLinks>;
  }[];
  readonly hash: string;
}
