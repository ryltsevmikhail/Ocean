import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { archiveCodingAssetTree } from './index.js';
import { publicationFixture } from '../test-fixtures/coding-publication.test.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
  };
});
it.each(['target mount', 'missing original', 'linked original', 'replaced header', 'added next'])(
  'refuses a changed %s at archive copy before staged bytes',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs'),
      f = publicationFixture();
    try {
      const archive = join(f.outer, 'archive'),
        copying = () => actual.existsSync(join(archive, '.incomplete'));
      const capture = f.collect().capture!;
      let fault = false,
        stagedReads = 0;
      vi.mocked(fs.readFileSync).mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        const data = actual.readFileSync(...args),
          path = String(args[0]);
        if (
          copying() &&
          path.startsWith('/proc/self/fdinfo/') &&
          actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === f.destination &&
          typeof data === 'string'
        ) {
          if (!fault && kind === 'missing original')
            actual.renameSync(f.before, join(f.outer, 'retained'));
          if (!fault && kind === 'linked original')
            actual.linkSync(f.before, join(f.outer, 'retained'));
          if (!fault && kind === 'replaced header')
            actual.writeFileSync(join(f.leaf, 'scope.json'), 'foreign header');
          if (!fault && kind === 'added next') actual.writeFileSync(f.main + '.next', 'partial');
          fault = true;
          if (kind === 'target mount') return data.replace(/^mnt_id:\s+\d+$/m, 'mnt_id: 999999999');
        }
        return data;
      }) as typeof fs.readFileSync);
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (copying() && actual.realpathSync('/proc/self/fd/' + args[0]) === f.after) stagedReads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      expect(() => archiveCodingAssetTree(capture, archive)).toThrow();
      expect(fault).toBe(true);
      expect(stagedReads).toBe(0);
      expect(actual.readFileSync(f.after, 'utf8')).toBe('new');
      expect(
        actual.readFileSync(
          kind.endsWith('original') ? join(f.outer, 'retained') : f.before,
          'utf8',
        ),
      ).toBe('old');
      expect(actual.existsSync(join(archive, '.incomplete'))).toBe(true);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      f.close();
    }
  },
);
it('accepts only the issued publication handle before opening any source or project path', () => {
  const f = publicationFixture();
  try {
    const capture = f.collect().capture!,
      clone = structuredClone(capture);
    vi.mocked(fs.openSync).mockClear();
    expect(() => archiveCodingAssetTree(clone, join(f.outer, 'archive'))).toThrow(
      'invalid_coding_asset_capture',
    );
    Object.assign(capture, { root: f.project });
    expect(() => archiveCodingAssetTree(capture, join(f.outer, 'archive'))).toThrow(
      'invalid_coding_asset_capture',
    );
    expect(fs.openSync).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it('rechecks the project name after hashing the remaining files in the final scope pass', async () => {
  const f = publicationFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  let reads = 0,
    changed = false;
  const detached = join(f.outer, 'detached-parent');
  try {
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const path = actual.realpathSync('/proc/self/fd/' + args[0]);
      const count = actual.readSync(...args);
      if (path === f.before) reads++;
      if (
        !changed &&
        reads === 3 &&
        path === join(f.leaf, 'scope.json') &&
        Buffer.isBuffer(args[1]) &&
        args[1].length === 1048576
      ) {
        actual.renameSync(join(f.project, 'dir'), detached);
        changed = true;
      }
      return count;
    }) as typeof fs.readSync);
    expect(f.collect).toThrow();
    expect(changed).toBe(true);
    expect(actual.readFileSync(join(detached, 'file'), 'utf8')).toBe('new');
    expect(actual.statSync(f.after).nlink).toBe(2);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    f.close();
  }
});
