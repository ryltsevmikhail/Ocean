import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as api from './index.js';
import { dependencyFixture, digest } from '../test-fixtures/coding-dependencies.test.js';
it('captures exact registry, selected dependency/toolchain bytes and virtual workspace links with missing checkout', async () => {
  const f = dependencyFixture();
  try {
    const captures: string[] = [];
    const catalog = await api.captureCodingDependencyAssets(
      f.inventory(),
      f.profile,
      f.trees(),
      async ({ slot, capture }) => {
        api.archiveCodingAssetTree(capture, join(f.outer, slot));
        captures.push(slot);
      },
    );
    expect(catalog.projects.map((p) => [p.id, p.selection])).toEqual([
      ['workspace', 'selected'],
      ['unselected', 'metadata-only'],
    ]);
    expect(catalog.tasks[0]?.links).toContainEqual({
      path: 'workspace/node_modules/local',
      target: 'workspace/packages/local',
    });
    expect(catalog.configuration.presence).toBe('present');
    expect(Buffer.from(catalog.configuration.bytes!, 'base64')).toEqual(
      fs.readFileSync(join(f.profile, 'coding-projects.json')),
    );
    expect(captures).toHaveLength(2);
    expect(fs.existsSync(f.project)).toBe(false);
  } finally {
    f.close();
  }
});
it.each(['registry', 'dependency', 'toolchain', 'tree', 'dto'] as const)(
  'rechecks %s after the last consumer with private witnesses',
  async (kind) => {
    const f = dependencyFixture();
    try {
      let count = 0;
      await expect(
        api.captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async (input) => {
          if (kind === 'dto')
            (input.capture as { sourceStateHash: string }).sourceStateHash = 'forged';
          if (++count !== 2) return;
          const file =
            kind === 'registry'
              ? join(f.profile, 'coding-projects.json')
              : kind === 'toolchain'
                ? join(f.bin, 'pnpm')
                : kind === 'tree'
                  ? join(f.tree, 'packages/local/index.js')
                  : join(f.deps, 'node_modules/pkg');
          const bytes = fs.readFileSync(file);
          bytes[0] = bytes[0] === 88 ? 89 : 88;
          fs.writeFileSync(file, bytes);
        }),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  },
);
it.each([
  'missing-registration',
  'policy',
  'unknown-mount',
  'missing-package',
  'absolute-link',
  'outside-hardlink',
  'protected-name',
])('refuses %s instead of claiming closure', async (kind) => {
  const f = dependencyFixture();
  try {
    const inventory = f.inventory();
    if (kind === 'missing-registration') f.registry.shift();
    if (kind === 'policy') f.registry[0]!.testPresets = [];
    if (kind === 'unknown-mount') f.registry[0]!.mounts.push({ source: f.outer, target: '/host' });
    if (kind === 'missing-package') fs.rmSync(join(f.tree, 'packages'), { recursive: true });
    if (kind === 'absolute-link') {
      fs.unlinkSync(join(f.deps, 'node_modules/local'));
      fs.symlinkSync('/workspace/packages/local', join(f.deps, 'node_modules/local'));
    }
    if (kind === 'outside-hardlink')
      fs.linkSync(join(f.deps, 'node_modules/pkg'), join(f.outer, 'secret'));
    if (kind === 'protected-name')
      fs.writeFileSync(join(f.deps, 'node_modules/.env'), 'synthetic-secret');
    f.save();
    await expect(
      api.captureCodingDependencyAssets(inventory, f.profile, f.trees(), async () => {}),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
it('distinguishes stable absent configuration and refuses appearance after consumption', async () => {
  const f = dependencyFixture();
  try {
    fs.unlinkSync(join(f.profile, 'coding-projects.json'));
    const body = { format: 1 as const, tasks: [], worktrees: [], changesets: [], applications: [] };
    const inventory = { ...body, hash: digest(body) };
    const result = await api.captureCodingDependencyAssets(
      inventory,
      f.profile,
      [],
      async () => {},
    );
    expect(result.configuration).toMatchObject({ presence: 'absent', bytes: null, sha256: null });
    await expect(
      api.captureCodingDependencyAssets(f.inventory(), f.profile, [], async () => {}),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
it('does not let mutated consumer DTOs redefine source expectations or catalog mapping', async () => {
  const f = dependencyFixture();
  try {
    const result = await api.captureCodingDependencyAssets(
      f.inventory(),
      f.profile,
      f.trees(),
      async (input) => {
        (input.capture as { sourceStateHash: string }).sourceStateHash = 'changed';
        (input.capture.manifest as { hash: string }).hash = 'changed';
      },
    );
    expect(result.tasks[0]!.mappings.every((m) => /^[a-f0-9]{64}$/.test(m.manifestHash))).toBe(
      true,
    );
  } finally {
    f.close();
  }
});
it('retains missing unselected declared assets as metadata but refuses an unsupported unselected mount', async () => {
  const f = dependencyFixture();
  try {
    f.registry[1]!.dependencyProjectRoot = join(f.outer, 'missing-dependencies');
    f.registry[1]!.mounts = [
      {
        source: join(f.outer, 'missing-dependencies/node_modules'),
        target: '/workspace/node_modules',
      },
    ];
    f.save();
    const result = await api.captureCodingDependencyAssets(
      f.inventory(),
      f.profile,
      f.trees(),
      async () => {},
    );
    expect(result.projects[1]!.selection).toBe('metadata-only');
    f.registry[1]!.mounts[0]!.target = '/host';
    f.save();
    await expect(
      api.captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {}),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
