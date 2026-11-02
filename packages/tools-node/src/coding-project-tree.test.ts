import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureCodingProjectTree } from './coding-project-tree.js';
it('observes the full eligible tree, including unchanged files, modes and new paths, without staging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-project-tree-'));
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    writeFileSync(join(root, 'a'), 'base');
    writeFileSync(join(root, 'unchanged'), 'keep');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'base',
    );
    const base = git('rev-parse', 'HEAD');
    const before = await captureCodingProjectTree(root, base);
    writeFileSync(join(root, 'a'), 'after');
    const after = await captureCodingProjectTree(root, base);
    expect(after).not.toEqual(before);
    writeFileSync(join(root, 'unchanged'), 'user');
    expect(await captureCodingProjectTree(root, base)).not.toEqual(after);
    writeFileSync(join(root, 'unchanged'), 'keep');
    expect(await captureCodingProjectTree(root, base)).toEqual(after);
    chmodSync(join(root, 'a'), 0o755);
    expect(await captureCodingProjectTree(root, base)).not.toEqual(after);
    chmodSync(join(root, 'a'), 0o644);
    writeFileSync(join(root, 'new'), 'new');
    expect(await captureCodingProjectTree(root, base)).not.toEqual(after);
    expect(git('diff', '--cached')).toBe('');
    await expect(captureCodingProjectTree(root, '0'.repeat(40))).rejects.toThrow();
    mkdirSync(join(root, 'sub'));
    await expect(captureCodingProjectTree(join(root, 'sub'), base)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
