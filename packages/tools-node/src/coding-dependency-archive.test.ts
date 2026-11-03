import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import * as api from './index.js';
import { dependencyFixture, digest } from '../test-fixtures/coding-dependencies.test.js';
it('verifies and materializes dependency/toolchain and task package closure after all sources are removed', async () => {
  const f = dependencyFixture();
  try {
    const output = join(f.outer, 'archive');
    await api.archiveCodingDependencyAssets(f.inventory(), f.profile, f.trees(), output);
    for (const source of [f.profile, f.deps, f.tree, f.bin]) fs.rmSync(source, { recursive: true });
    expect(api.verifyCodingDependencyArchive(output).tasks[0]?.taskId).toBe('task');
    api.restoreCodingDependencyTask(output, 'task', join(f.outer, 'quarantine'));
    const tree = join(f.outer, 'quarantine/materialized/tree');
    expect(fs.readFileSync(join(tree, 'workspace/node_modules/local/index.js'), 'utf8')).toBe(
      'module.exports=42;',
    );
    expect(fs.readlinkSync(join(tree, 'workspace/node_modules/local'))).toBe('../packages/local');
    expect(fs.statSync(join(tree, 'workspace/node_modules/pkg')).ino).toBe(
      fs.statSync(join(tree, 'workspace/node_modules/copy')).ino,
    );
    expect(fs.statSync(join(tree, 'workspace/node_modules/pkg')).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(join(tree, 'toolchain/pnpm/bin/pnpm'), 'utf8')).toBe(
      '#!/bin/sh\nprintf synthetic',
    );
    expect(fs.existsSync(f.project)).toBe(false);
  } finally {
    f.close();
  }
});
it.each(['config', 'mapping', 'blob', 'missing-tree'])(
  'independent verifier refuses %s corruption',
  async (kind) => {
    const f = dependencyFixture();
    try {
      const output = join(f.outer, 'archive');
      const catalog = await api.archiveCodingDependencyAssets(
        f.inventory(),
        f.profile,
        f.trees(),
        output,
      );
      if (kind === 'config' || kind === 'mapping') {
        const path = join(output, 'catalog.json'),
          raw = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (kind === 'config') raw.configuration.bytes = Buffer.from('[]').toString('base64');
        else raw.tasks[0].mappings[0].target = '/host';
        fs.writeFileSync(path, JSON.stringify(raw));
      } else if (kind === 'missing-tree')
        fs.rmSync(join(output, 'tree-' + catalog.tasks[0]!.treeHash), { recursive: true });
      else {
        const slot = catalog.tasks[0]!.mappings[0]!.slot,
          dir = join(output, slot, 'blobs');
        fs.writeFileSync(join(dir, fs.readdirSync(dir)[0]!), 'corrupt');
      }
      expect(() => api.verifyCodingDependencyArchive(output)).toThrow();
      expect(() =>
        api.restoreCodingDependencyTask(output, 'task', join(f.outer, 'refused')),
      ).toThrow();
      expect(fs.existsSync(join(f.outer, 'refused'))).toBe(false);
    } finally {
      f.close();
    }
  },
);
it('refuses an archive destination inside a captured task before creating source entries', async () => {
  const f = dependencyFixture();
  try {
    const destination = join(f.tree, 'forbidden-output');
    await expect(
      api.archiveCodingDependencyAssets(f.inventory(), f.profile, f.trees(), destination),
    ).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  } finally {
    f.close();
  }
});
it('preserves hardlink groups whose first path is in a directory before a similarly named sibling', async () => {
  const f = dependencyFixture();
  try {
    fs.mkdirSync(join(f.deps, 'node_modules/a'));
    fs.writeFileSync(join(f.deps, 'node_modules/a/file'), 'linked');
    fs.linkSync(join(f.deps, 'node_modules/a/file'), join(f.deps, 'node_modules/a.txt'));
    const out = join(f.outer, 'archive');
    await api.archiveCodingDependencyAssets(f.inventory(), f.profile, f.trees(), out);
    api.restoreCodingDependencyTask(out, 'task', join(f.outer, 'q'));
    const path = join(f.outer, 'q/materialized/tree/workspace/node_modules');
    expect(fs.statSync(join(path, 'a/file')).ino).toBe(fs.statSync(join(path, 'a.txt')).ino);
  } finally {
    f.close();
  }
});
it.each(['task', 'root', 'policy', 'later-task'] as const)(
  'validates the complete frozen tree %s selection before any source body or archive copy',
  async (kind) => {
    const f = dependencyFixture(),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      const valid = f.trees()[0]!,
        other = join(f.outer, 'unselected');
      fs.mkdirSync(other, { mode: 0o700 });
      fs.writeFileSync(join(other, 'canary'), 'synthetic unselected body');
      const input =
        kind === 'root'
          ? { taskId: 'task', capture: api.captureCodingAssetTree(other, {}, 'coding-worktree') }
          : kind === 'policy'
            ? { taskId: 'task', capture: api.captureCodingAssetTree(f.tree) }
            : { ...valid, taskId: 'not-a-frozen-task' };
      const trees = kind === 'later-task' ? [valid, input] : [input];
      let reads = 0;
      const output = join(f.outer, 'refused');
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actual.readlinkSync('/proc/self/fd/' + args[0]);
        if (path.startsWith(f.tree + '/') || path.startsWith(other + '/')) reads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      await expect(
        api.archiveCodingDependencyAssets(f.inventory(), f.profile, trees, output),
      ).rejects.toThrow('invalid_coding_dependency');
      expect(reads).toBe(0);
      expect(
        fs.existsSync(output)
          ? fs.readdirSync(output).filter((name) => name.startsWith('tree-'))
          : [],
      ).toEqual([]);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
it.each(['bytes', 'entries', 'metadata'] as const)(
  'charges the combined selected-tree %s budget before any tree body or archive copy',
  async (kind) => {
    const f = dependencyFixture(),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      if (kind === 'bytes')
        fs.writeFileSync(join(f.tree, 'budget-body'), Buffer.alloc(3 * 1048576, 88));
      if (kind === 'entries')
        for (let i = 0; i < 100; i++)
          fs.linkSync(join(f.tree, 'packages/local/index.js'), join(f.tree, 'alias-' + i));
      if (kind === 'metadata') {
        let path = f.tree;
        for (let i = 0; i < 17; i++) {
          path = join(path, 'd'.repeat(200));
          fs.mkdirSync(path);
        }
        fs.writeFileSync(join(path, 'body'), 'synthetic');
      }
      const capture = f.trees()[0]!.capture,
        original = f.inventory(),
        { hash: _hash, ...body } = original;
      const tasks = Array.from({ length: kind === 'bytes' ? 701 : 1000 }, (_, i) => ({
        ...body.tasks[0]!,
        id: 'task-' + i,
      }));
      const frozen = { ...body, tasks },
        inventory = { ...frozen, hash: digest(frozen) },
        trees = tasks.map((t) => ({ taskId: t.id, capture }));
      let reads = 0;
      const output = join(f.outer, 'over-budget');
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (actual.readlinkSync('/proc/self/fd/' + args[0]).startsWith(f.tree + '/')) reads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      await expect(
        api.archiveCodingDependencyAssets(inventory, f.profile, trees, output),
      ).rejects.toThrow('coding_asset_limit');
      expect(reads).toBe(0);
      expect(
        fs.existsSync(output)
          ? fs.readdirSync(output).filter((name) => name.startsWith('tree-'))
          : [],
      ).toEqual([]);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
it('checks every selected tree against its original metadata before copying even the first tree', async () => {
  const f = dependencyFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  try {
    const other = join(f.outer, 'second-tree'),
      canary = join(f.outer, 'synthetic-credential');
    fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(join(other, 'body'), 'original');
    fs.writeFileSync(canary, 'synthetic private body');
    const trees = [
      ...f.trees(),
      { taskId: 'second', capture: api.captureCodingAssetTree(other, {}, 'coding-worktree') },
    ];
    const { hash: _hash, ...original } = f.inventory(),
      body = {
        ...original,
        tasks: [...original.tasks, { ...original.tasks[0]!, id: 'second', worktreeRoot: other }],
      },
      inventory = { ...body, hash: digest(body) };
    fs.unlinkSync(join(other, 'body'));
    fs.linkSync(canary, join(other, 'body'));
    let reads = 0;
    const output = join(f.outer, 'stale-selection');
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const path = actual.readlinkSync('/proc/self/fd/' + args[0]);
      if (path.startsWith(f.tree + '/') || path.startsWith(other + '/')) reads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    await expect(
      api.archiveCodingDependencyAssets(inventory, f.profile, trees, output),
    ).rejects.toThrow('stale_coding_asset');
    expect(reads).toBe(0);
    expect(
      fs.existsSync(output)
        ? fs.readdirSync(output).filter((name) => name.startsWith('tree-'))
        : [],
    ).toEqual([]);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    f.close();
  }
});
it('charges frozen non-task inventory metadata together with private tree witnesses before copying', async () => {
  const f = dependencyFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  try {
    let path = f.tree;
    for (let i = 0; i < 17; i++) {
      path = join(path, 'd'.repeat(200));
      fs.mkdirSync(path);
    }
    fs.writeFileSync(join(path, 'body'), 'synthetic');
    const capture = f.trees()[0]!.capture,
      { hash: _hash, ...original } = f.inventory();
    const tasks = Array.from({ length: 400 }, (_, i) => ({
      ...original.tasks[0]!,
      id: 'task-' + i,
    }));
    const changesets = Array.from({ length: 3000 }, (_, i) => ({
      hash: i.toString(16).padStart(64, '0'),
      taskId: 'task-0',
      baseCommit: 'a'.repeat(40),
      beforeTreeHash: 'b'.repeat(64),
      afterTreeHash: 'c'.repeat(64),
      files: [
        {
          path: 'p'.repeat(4000),
          before: null,
          after: { mode: '100644' as const, sha256: 'd'.repeat(64) },
        },
      ],
    }));
    const body = { ...original, tasks, changesets },
      inventory = { ...body, hash: digest(body) };
    let reads = 0;
    const output = join(f.outer, 'combined-metadata');
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (actual.readlinkSync('/proc/self/fd/' + args[0]).startsWith(f.tree + '/')) reads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    await expect(
      api.archiveCodingDependencyAssets(
        inventory,
        f.profile,
        tasks.map((t) => ({ taskId: t.id, capture })),
        output,
      ),
    ).rejects.toThrow('coding_asset_limit');
    expect(reads).toBe(0);
    expect(
      fs.existsSync(output)
        ? fs.readdirSync(output).filter((name) => name.startsWith('tree-'))
        : [],
    ).toEqual([]);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    f.close();
  }
}, 15000);
