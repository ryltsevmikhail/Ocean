import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as api from './index.js';
import { dependencyFixture } from '../test-fixtures/coding-dependencies.test.js';
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
