import { truncate, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fingerprintTree } from './sandbox-tree.js';

it('attests dependency bytes and symlink text without following links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-tree-'));
  try {
    await mkdir(join(root, 'tree'));
    await writeFile(join(root, 'tree/package'), 'before');
    await symlink('../unmounted', join(root, 'tree/link'));
    const before = fingerprintTree(join(root, 'tree'));
    await writeFile(join(root, 'tree/package'), 'after');
    expect(fingerprintTree(join(root, 'tree'))).not.toBe(before);
    const after = fingerprintTree(join(root, 'tree'));
    await writeFile(join(root, 'unmounted'), 'outside');
    expect(fingerprintTree(join(root, 'tree'))).toBe(after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses an oversized sparse dependency before reading its contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-tree-limit-'));
  try {
    const file = join(root, 'oversized');
    await writeFile(file, '');
    await truncate(file, 1073741825);
    expect(() => fingerprintTree(root)).toThrow('dependency byte limit');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 1000);
