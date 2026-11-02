import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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
