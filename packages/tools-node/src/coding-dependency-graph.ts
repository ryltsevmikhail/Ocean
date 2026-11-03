import { checkDependencyPath } from './coding-dependency-path.js';
import * as fs from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  validCodingBackupPolicy,
  type CodingBackupInventory,
  type CodingAssetManifest,
} from '@runnets/domain';
import { assetDirectoryFlags } from './coding-asset-io.js';
import {
  captureAssetTreeAt,
  checkedArchiveInput,
  CODING_ASSET_LIMITS,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { scanAssetSource } from './coding-asset-source.js';
import { planAssetSelection } from './coding-asset-selection.js';
import { checkAssetPolicy } from './coding-asset-policy.js';
import {
  holdCodingConfiguration,
  dependencyHash,
  dependencyFail,
} from './coding-dependency-config.js';
import { dependencyVirtualTree } from './coding-dependency-mapping.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
export type {
  CodingDependencyTree,
  CodingDependencyInput,
  CodingDependencyCatalog,
} from './coding-dependency-types.js';
import type {
  CodingDependencyTree,
  CodingDependencyInput,
  CodingDependencyCatalog,
} from './coding-dependency-types.js';
import { holdDependencyMappingRoot } from './coding-dependency-witness.js';
import { DependencyBudget } from './coding-dependency-budget.js';
/** Selected dependency subgraph. Caller holds profile maintenance ownership through the last consumer. */
export async function captureCodingDependencyAssets(
  frozen: CodingBackupInventory,
  profile: string,
  taskTrees: readonly CodingDependencyTree[],
  consume: (input: CodingDependencyInput) => Promise<void>,
): Promise<CodingDependencyCatalog> {
  const inventory = structuredClone(frozen),
    { hash: inventoryHash, ...body } = inventory;
  if (
    inventory.format !== 1 ||
    dependencyHash(body) !== inventoryHash ||
    inventory.tasks.length > 1000 ||
    taskTrees.length > 1000 ||
    new Set(inventory.tasks.map((t) => t.id)).size !== inventory.tasks.length
  )
    return dependencyFail();
  const held = holdCodingConfiguration(profile),
    opened: number[] = [],
    mappingRoots = new Map<string, ReturnType<typeof holdDependencyMappingRoot>>();
  try {
    const projects = held.projects.map((p) => ({
      ...p,
      selection: inventory.tasks.some((t) => t.projectRoot === p.root)
        ? ('selected' as const)
        : ('metadata-only' as const),
    }));
    const trees = new Map<string, CodingAssetCapture>();
    for (const input of taskTrees) {
      const task = inventory.tasks.find((t) => t.id === input.taskId),
        snapshot = checkedArchiveInput(input.capture).snapshot;
      if (
        !task ||
        snapshot.root !== task.worktreeRoot ||
        snapshot.policy !== 'coding-worktree' ||
        snapshot.manifest.selectedFiles ||
        trees.has(task.id)
      )
        return dependencyFail();
      trees.set(task.id, snapshot);
    }
    const plans = new Map<
      string,
      {
        source: string;
        target: string;
        root: string;
        file: string | null;
        fd?: number;
        metadata?: CodingAssetCapture;
      }
    >();
    for (const task of inventory.tasks) {
      const project = projects.find((p) => p.root === task.projectRoot);
      if (
        !project ||
        project.root !== task.projectRoot ||
        !validCodingBackupPolicy(task.policyVersion, task.policy) ||
        dependencyHash(project.testPresets) !== dependencyHash(task.policy.testPresets)
      )
        return dependencyFail();
      if (
        project.dependencyProjectRoot &&
        project.mounts.some((m) => m.target.startsWith('/workspace/')) &&
        !mappingRoots.has(project.dependencyProjectRoot)
      )
        mappingRoots.set(
          project.dependencyProjectRoot,
          holdDependencyMappingRoot(project.dependencyProjectRoot),
        );
      const targets = new Set<string>();
      for (const mount of project.mounts) {
        if (targets.has(mount.target)) return dependencyFail();
        targets.add(mount.target);
        const file = mount.target === '/toolchain/pnpm/bin/pnpm' ? basename(mount.source) : null;
        if (
          file === null &&
          (!project.dependencyProjectRoot ||
            !/^\/workspace\/(?:[A-Za-z0-9_-]+\/)*node_modules$/.test(mount.target) ||
            mount.source !==
              join(project.dependencyProjectRoot, relative('/workspace', mount.target)))
        )
          return dependencyFail();
        // Root aliases and protected source components are rejected without body reads.
        checkAssetPolicy(
          'coding-dependency',
          mount.source.slice(1),
          fs.lstatSync(mount.source, { bigint: true }),
        );
        if (fs.realpathSync(mount.source) !== mount.source || mount.source === process.env['HOME'])
          return dependencyFail();
        const stat = fs.lstatSync(mount.source);
        if (
          file !== null
            ? !stat.isFile() || stat.nlink !== 1 || !(stat.mode & 0o111)
            : !stat.isDirectory()
        )
          return dependencyFail();
        const slot = dependencyHash([mount.source, mount.target]);
        plans.set(slot, {
          source: mount.source,
          target: mount.target,
          root: file === null ? mount.source : dirname(mount.source),
          file,
        });
      }
      if (
        project.mounts.some((a) =>
          project.mounts.some((b) => a !== b && a.target.startsWith(b.target + '/')),
        )
      )
        return dependencyFail();
    }
    const budget = new DependencyBudget();
    budget.metadata([held.configuration, projects, inventory.tasks]);
    // All namespaces, types, mounts and alias counts precede ANY dependency content.
    for (const plan of plans.values()) {
      plan.fd = fs.openSync(plan.root, assetDirectoryFlags);
      opened.push(plan.fd);
      checkDependencyPath(plan.fd, plan.root);
      plan.metadata = scanAssetSource(
        plan.root,
        {
          ...CODING_ASSET_LIMITS,
          bytes: Math.max(0, 2147483648 - budget.bytes),
          entries: Math.max(1, 100000 - budget.entries),
        },
        plan.file === null ? 'coding-dependency' : 'coding-worktree',
        undefined,
        true,
        plan.fd,
        plan.file === null ? undefined : planAssetSelection([plan.file], CODING_ASSET_LIMITS),
      );
      budget.capture(plan.metadata);
    }
    for (const tree of trees.values()) budget.capture(tree);
    const metadata = new Map([...plans].map(([slot, p]) => [slot, p.metadata!.manifest]));
    // Resolve link text against metadata before hashing selected bodies.
    for (const task of inventory.tasks) {
      const project = projects.find((p) => p.root === task.projectRoot)!;
      const mappings = project.mounts.map((m) => {
        const slot = dependencyHash([m.source, m.target]),
          plan = plans.get(slot)!;
        return {
          slot,
          source: m.source,
          target: m.target,
          file: plan.file,
          manifestHash: plan.metadata!.manifest.hash,
        };
      });
      dependencyVirtualTree(mappings, metadata, trees.get(task.id)?.manifest, true);
    }
    const manifests = new Map<string, CodingAssetManifest>(),
      witnesses = new Map<string, { state: string; hash: string }>();
    for (const [slot, plan] of plans) {
      const capture = captureAssetTreeAt(
        plan.root,
        plan.metadata!.limits,
        plan.file === null ? 'coding-dependency' : 'coding-worktree',
        plan.fd,
        (m) => {
          if (m.sourceStateHash !== plan.metadata!.sourceStateHash)
            throw Error('stale_coding_asset');
        },
        plan.file === null ? undefined : [plan.file],
      );
      manifests.set(slot, structuredClone(capture.manifest));
      witnesses.set(slot, { state: capture.sourceStateHash, hash: capture.manifest.hash });
      await consume({ slot, capture });
    }
    const tasks = inventory.tasks.map((task) => {
      const project = projects.find((p) => p.root === task.projectRoot)!;
      const mappings = project.mounts.map((m) => {
        const slot = dependencyHash([m.source, m.target]);
        return {
          slot,
          source: m.source,
          target: m.target,
          file: plans.get(slot)!.file,
          manifestHash: manifests.get(slot)!.hash,
        };
      });
      const virtual = dependencyVirtualTree(mappings, manifests, trees.get(task.id)?.manifest);
      const record = {
        taskId: task.id,
        projectId: project.id,
        policyHash: dependencyHash([task.policyVersion, task.policy]),
        treeHash: trees.get(task.id)?.manifest.hash ?? null,
        treeSelection: trees.has(task.id) ? ('captured' as const) : ('not-supplied' as const),
        mappings,
        virtualHash: virtual.hash,
        links: validateCodingAssetLinks(virtual),
      };
      budget.metadata(record);
      return record;
    });
    // Private snapshots, never consumer DTOs, define final expectations.
    for (const [slot, plan] of plans) {
      checkDependencyPath(plan.fd!, plan.root);
      const current = captureAssetTreeAt(
        plan.root,
        plan.metadata!.limits,
        plan.file === null ? 'coding-dependency' : 'coding-worktree',
        plan.fd,
        (m) => {
          if (m.sourceStateHash !== plan.metadata!.sourceStateHash)
            throw Error('stale_coding_asset');
        },
        plan.file === null ? undefined : [plan.file],
      );
      const expected = witnesses.get(slot)!;
      if (current.sourceStateHash !== expected.state || current.manifest.hash !== expected.hash)
        throw Error('stale_coding_asset');
    }
    for (const tree of trees.values()) {
      const current = captureAssetTreeAt(tree.root, tree.limits, tree.policy);
      if (
        current.sourceStateHash !== tree.sourceStateHash ||
        current.manifest.hash !== tree.manifest.hash
      )
        throw Error('stale_coding_asset');
    }
    for (const root of mappingRoots.values()) root.verify();
    held.verify();
    const catalog = {
      format: 1 as const,
      inventoryHash,
      configuration: held.configuration,
      projects,
      tasks,
    };
    if (Buffer.byteLength(JSON.stringify(catalog)) > 16777216) throw Error('coding_asset_limit');
    return { ...catalog, hash: dependencyHash(catalog) };
  } finally {
    for (const fd of opened) fs.closeSync(fd);
    for (const root of mappingRoots.values()) root.close();
    held.close();
  }
}
