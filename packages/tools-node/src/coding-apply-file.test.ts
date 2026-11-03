import {
  openSync,
  closeSync,
  writeSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  linkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CodingFileContent } from '@runnets/domain';
import { applyCodingFile } from './coding-apply-file.js';
const content = (text: string, mode: '100644' | '100755' = '100644'): CodingFileContent => ({
  mode,
  text,
  sha256: createHash('sha256').update(text).digest('hex'),
});
function fixture(work: (root: string, recovery: string, outer: string) => void) {
  const outer = mkdtempSync(join(tmpdir(), 'ocean-apply-file-'));
  const root = join(outer, 'project'),
    recovery = join(outer, 'recovery');
  mkdirSync(root);
  mkdirSync(recovery, { mode: 0o700 });
  try {
    work(root, recovery, outer);
  } finally {
    rmSync(outer, { force: true, recursive: true });
  }
}
it('applies exact UTF-8 bytes and mode while retaining the displaced original and durable intent', () =>
  fixture((root, recovery) => {
    writeFileSync(join(root, 'file'), 'old', { mode: 0o644 });
    applyCodingFile(root, recovery, {
      path: 'file',
      before: content('old'),
      after: content('\ufeffnew\r\n', '100755'),
    });
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('\ufeffnew\r\n');
    expect(lstatSync(join(root, 'file')).mode & 0o777).toBe(0o755);
    const entries = readdirSync(recovery);
    const backup = entries.find((name) => name.endsWith('.before'))!;
    expect(readFileSync(join(recovery, backup), 'utf8')).toBe('old');
    const record = JSON.parse(
      readFileSync(
        join(
          recovery,
          entries.find((n) => n.endsWith('.json'))!,
        ),
        'utf8',
      ),
    ) as { path: string; status: string };
    expect(record).toMatchObject({ path: 'file', status: 'completed' });
  }));
it('creates missing parents and empty files, and deletes only the exact expected file', () =>
  fixture((root, recovery) => {
    applyCodingFile(root, recovery, { path: 'new/empty', before: null, after: content('') });
    expect(readFileSync(join(root, 'new/empty'), 'utf8')).toBe('');
    applyCodingFile(root, recovery, { path: 'new/empty', before: content(''), after: null });
    expect(readdirSync(join(root, 'new'))).toEqual([]);
  }));
it.each(['changed', 'mode', 'symlink', 'parent-link', 'hardlink', 'hash'])(
  'refuses %s without overwriting user files',
  (kind) =>
    fixture((root, recovery, outer) => {
      writeFileSync(join(root, 'file'), 'old', { mode: kind === 'mode' ? 0o755 : 0o644 });
      let path = 'file';
      if (kind === 'changed') writeFileSync(join(root, 'file'), 'user');
      if (kind === 'symlink') {
        rmSync(join(root, 'file'));
        symlinkSync(join(outer, 'target'), join(root, 'file'));
      }
      if (kind === 'parent-link') {
        symlinkSync(outer, join(root, 'parent'));
        path = 'parent/target';
      }
      if (kind === 'hardlink') linkSync(join(root, 'file'), join(root, 'other'));
      writeFileSync(join(outer, 'target'), 'outside');
      expect(() =>
        applyCodingFile(root, recovery, {
          path,
          before: content('old'),
          after: kind === 'hash' ? { ...content('new'), sha256: 'wrong' } : content('new'),
        }),
      ).toThrow();
      expect(readFileSync(join(outer, 'target'), 'utf8')).toBe('outside');
      if (!['symlink', 'parent-link'].includes(kind))
        expect(readFileSync(join(root, 'file'), 'utf8')).toBe(kind === 'changed' ? 'user' : 'old');
    }),
);

it('keeps writes through an old open descriptor in the retained original', () =>
  fixture((root, recovery) => {
    writeFileSync(join(root, 'file'), 'old');
    const original = openSync(join(root, 'file'), 'r+');
    try {
      applyCodingFile(root, recovery, {
        path: 'file',
        before: content('old'),
        after: content('new'),
      });
      writeSync(original, 'user', 0, 'utf8');
      expect(readFileSync(join(root, 'file'), 'utf8')).toBe('new');
      const backup = readdirSync(recovery).find((name) => name.endsWith('.before'))!;
      expect(readFileSync(join(recovery, backup), 'utf8')).toBe('user');
    } finally {
      closeSync(original);
    }
  }));

it('preserves private access bits when adding executable mode', () =>
  fixture((root, recovery) => {
    writeFileSync(join(root, 'private'), 'old', { mode: 0o600 });
    applyCodingFile(root, recovery, {
      path: 'private',
      before: content('old'),
      after: content('new', '100755'),
    });
    expect(lstatSync(join(root, 'private')).mode & 0o777).toBe(0o700);
    applyCodingFile(root, recovery, { path: 'added', before: null, after: content('new') });
    expect(lstatSync(join(root, 'added')).mode & 0o777).toBe(0o600);
  }));

it('replaces a tree of empty directories left by approved descendant deletions', () =>
  fixture((root, recovery) => {
    mkdirSync(join(root, 'a/b/c'), { recursive: true });
    applyCodingFile(root, recovery, { path: 'a', before: null, after: content('file') });
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('file');
  }));
it('refuses directory replacement containing user data or symlinks', () =>
  fixture((root, recovery, outer) => {
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a/user'), 'keep');
    expect(() =>
      applyCodingFile(root, recovery, { path: 'a', before: null, after: content('new') }),
    ).toThrow();
    expect(readFileSync(join(root, 'a/user'), 'utf8')).toBe('keep');
    mkdirSync(join(root, 'b'));
    symlinkSync(outer, join(root, 'b/link'));
    expect(() =>
      applyCodingFile(root, recovery, { path: 'b', before: null, after: content('new') }),
    ).toThrow();
    expect(lstatSync(join(root, 'b/link')).isSymbolicLink()).toBe(true);
  }));

it('refuses protected directories even when they contain no files', () =>
  fixture((root, recovery) => {
    mkdirSync(join(root, 'a/.git'), { recursive: true });
    expect(() =>
      applyCodingFile(root, recovery, { path: 'a', before: null, after: content('new') }),
    ).toThrow();
    expect(lstatSync(join(root, 'a/.git')).isDirectory()).toBe(true);
  }));
