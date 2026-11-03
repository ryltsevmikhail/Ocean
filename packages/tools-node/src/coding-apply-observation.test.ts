import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { observeCodingFiles } from './coding-apply-observation.js';
it('reads only bounded pinned file entries and reports absent paths and directories separately', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-apply-observe-'));
  try {
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'file'), '\ufeffraw\r\n');
    chmodSync(join(root, 'file'), 0o755);
    expect(observeCodingFiles(root, ['file', 'missing', 'dir', 'file/child'])).toEqual([
      {
        path: 'file',
        kind: 'file',
        mode: '100755',
        sha256: createHash('sha256').update('\ufeffraw\r\n').digest('hex'),
      },
      { path: 'missing', kind: 'missing', mode: null, sha256: null },
      { path: 'dir', kind: 'directory', mode: null, sha256: null },
      { path: 'file/child', kind: 'missing', mode: null, sha256: null },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('does not follow links, read protected paths or accept oversized or multiply-linked files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-apply-observe-links-'));
  const root = join(directory, 'root');
  mkdirSync(root);
  try {
    writeFileSync(join(directory, 'outside'), 'private');
    symlinkSync(directory, join(root, 'parent'));
    symlinkSync(join(directory, 'outside'), join(root, 'link'));
    writeFileSync(join(root, 'hard'), 'hard');
    linkSync(join(root, 'hard'), join(root, 'alias'));
    writeFileSync(join(root, 'large'), Buffer.alloc(131073));
    for (const path of ['parent/outside', 'link', 'hard', 'large'])
      expect(observeCodingFiles(root, [path])[0]?.kind).toBe('unavailable');
    for (const path of ['../outside', '.git/config', '/etc/passwd'])
      expect(() => observeCodingFiles(root, [path])).toThrow();
    const linked = join(directory, 'linked');
    symlinkSync(root, linked);
    expect(() => observeCodingFiles(linked, ['hard'])).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
