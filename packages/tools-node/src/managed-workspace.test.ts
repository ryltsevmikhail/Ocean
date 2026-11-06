import { expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  linkSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openManagedWorkspace } from './managed-workspace.js';
it('holds the actual root and refuses symlinks, hardlinks and stale path reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-witness-'));
  const root = join(dir, 'root');
  mkdirSync(root);
  try {
    const held = openManagedWorkspace(root, new AbortController().signal);
    expect(held.inspect()).toBe(true);
    writeFileSync(join(root, 'legitimate'), 'x');
    expect(held.inspect()).toBe(true);
    renameSync(root, join(dir, 'old'));
    mkdirSync(root);
    expect(held.inspect()).toBe(false);
    held.close();
    symlinkSync(join(dir, 'old'), join(root, 'alias'));
    expect(() => openManagedWorkspace(root, new AbortController().signal)).toThrow();
    rmSync(join(root, 'alias'));
    writeFileSync(join(root, 'a'), 'x');
    linkSync(join(root, 'a'), join(root, 'b'));
    expect(() => openManagedWorkspace(root, new AbortController().signal)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('refuses expired physical preparation before traversing a workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-deadline-'));
  try {
    expect(() =>
      openManagedWorkspace(root, new AbortController().signal, [], Date.now() - 1),
    ).toThrow('deadline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
