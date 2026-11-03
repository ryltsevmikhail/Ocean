import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodingBackupInventory, CodingPolicy, CodingTestPreset } from '@runnets/domain';
import { captureCodingAssetTree } from '@runnets/tools-node';
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const policy: CodingPolicy = {
  version: 1,
  devCapabilities: ['project_read'],
  reviewCapabilities: ['changeset_read'],
  testPresets: [{ id: 'test', program: '/toolchain/pnpm/bin/pnpm', args: ['test'], cwd: '.' }],
};
export function dependencyFixture() {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-dependency-'));
  const profile = join(outer, 'profile'),
    project = join(outer, 'missing-project'),
    deps = join(outer, 'deps'),
    tree = join(outer, 'task'),
    bin = join(outer, 'bin');
  for (const p of [profile, deps, tree, bin]) fs.mkdirSync(p, { mode: 0o700 });
  fs.mkdirSync(join(deps, 'node_modules'));
  fs.mkdirSync(join(tree, 'packages'));
  fs.mkdirSync(join(tree, 'packages/local'));
  fs.writeFileSync(join(tree, 'packages/local/index.js'), 'module.exports=42;');
  fs.writeFileSync(join(deps, 'node_modules/pkg'), Buffer.from([0, 255, 1]), { mode: 0o755 });
  fs.linkSync(join(deps, 'node_modules/pkg'), join(deps, 'node_modules/copy'));
  fs.symlinkSync('../packages/local', join(deps, 'node_modules/local'));
  fs.writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf synthetic', { mode: 0o755 });
  const registry: {
    id: string;
    root: string;
    testPresets: readonly CodingTestPreset[];
    dependencyProjectRoot?: string;
    mounts: { source: string; target: string }[];
  }[] = [
    {
      id: 'workspace',
      root: project,
      testPresets: policy.testPresets,
      dependencyProjectRoot: deps,
      mounts: [
        { source: join(deps, 'node_modules'), target: '/workspace/node_modules' },
        { source: join(bin, 'pnpm'), target: '/toolchain/pnpm/bin/pnpm' },
      ],
    },
    { id: 'unselected', root: join(outer, 'unread-project'), testPresets: [], mounts: [] },
  ];
  const save = () =>
    fs.writeFileSync(join(profile, 'coding-projects.json'), JSON.stringify(registry) + '\n', {
      mode: 0o600,
    });
  save();
  const inventory = (): CodingBackupInventory => {
    const body = {
      format: 1 as const,
      tasks: [
        {
          id: 'task',
          workspaceId: 'ws_ocean',
          projectRoot: project,
          baseCommit: 'a'.repeat(40),
          worktreeRoot: tree,
          ownerId: 'owner',
          status: 'reserved' as const,
          policyVersion: 1 as const,
          policy,
        },
      ],
      worktrees: [],
      changesets: [],
      applications: [],
    };
    return { ...body, hash: digest(body) };
  };
  return {
    outer,
    profile,
    project,
    deps,
    tree,
    bin,
    registry,
    save,
    inventory,
    trees: () => [{ taskId: 'task', capture: captureCodingAssetTree(tree, {}, 'coding-worktree') }],
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
