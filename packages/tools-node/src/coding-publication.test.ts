import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  publicationFixture as fixture,
  app,
  id,
  context,
} from '../test-fixtures/coding-publication.test.js';
import {
  archiveCodingAssetTree,
  captureCodingAssetTree,
  captureScopedCodingApplyRecovery,
  restoreCodingAssetTree,
} from './index.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
it.each(['matching', 'conflict', 'mode conflict', 'addition'])(
  'preserves %s publication evidence and only restores independent data',
  async (kind) => {
    const f = fixture(kind === 'addition');
    const actual = await vi.importActual<typeof fs>('node:fs'),
      reads = new Set<string>();
    try {
      if (kind === 'conflict') {
        fs.writeFileSync(f.destination, 'BAD');

        fs.writeFileSync(f.before, 'bad');
      }
      if (kind === 'mode conflict') fs.chmodSync(f.destination, 0o750);
      const inode = fs.statSync(f.destination).ino;
      let metadataOpens = 0;
      vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
        const fd = actual.openSync(...args);
        if (actual.readlinkSync('/proc/self/fd/' + fd) === f.destination) {
          metadataOpens++;
          expect(typeof args[1] === 'number' && (args[1] & 0x200000) !== 0).toBe(true);
        }
        return fd;
      }) as typeof fs.openSync);
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        reads.add(actual.realpathSync('/proc/self/fd/' + args[0]));
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      expect(() => captureCodingAssetTree(f.leaf, {}, 'coding-recovery-v2')).toThrow();
      const result = f.collect();
      expect(result.records).toMatchObject([
        {
          path: 'dir/file',
          status: 'started',
          publicationLink: kind.endsWith('conflict') ? 'conflict' : 'matching',
          original:
            kind === 'addition' ? 'not-required' : kind === 'conflict' ? 'conflict' : 'matching',
        },
      ]);
      const archive = join(f.outer, 'archive'),
        output = join(f.outer, 'quarantine');
      archiveCodingAssetTree(result.capture!, archive);
      expect(restoreCodingAssetTree(archive, output)).toEqual(result.capture!.manifest);
      expect(reads.has(f.destination)).toBe(false);
      expect(metadataOpens).toBeGreaterThan(0);
      const staged = join(output, 'tree/files', id + '.after');
      for (const path of [
        'scope.json',
        'files/' + id + '.json',
        'files/' + id + '.after',
        ...(kind === 'addition' ? [] : ['files/' + id + '.before']),
      ])
        expect(fs.readFileSync(join(output, 'tree', path))).toEqual(
          fs.readFileSync(join(f.leaf, path)),
        );
      expect(fs.statSync(staged).mode & 0o777).toBe(kind === 'mode conflict' ? 0o750 : 0o640);
      expect(fs.statSync(staged).nlink).toBe(1);
      expect(fs.statSync(staged).ino).not.toBe(inode);
      expect(fs.statSync(f.destination)).toMatchObject({ ino: inode, nlink: 2 });
      expect(fs.readFileSync(f.destination, 'utf8')).toBe(kind === 'conflict' ? 'BAD' : 'new');
    } finally {
      vi.mocked(fs.openSync).mockImplementation(actual.openSync);
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
it.each([
  'wrong inode',
  'missing target',
  'missing root',
  'three links',
  'symlink parent',
  'symlink file',
  'mount',
  'missing original',
  'next',
  'completion next',
  'malformed intent',
  'completed',
  'null after',
  'duplicate',
  'pending',
  'foreign intent',
  'before link',
  'main link',
  'header link',
])('refuses %s before staged body reads and preserves the source', async (kind) => {
  const f = fixture(),
    elsewhere = join(f.outer, 'elsewhere');
  const actual = await vi.importActual<typeof fs>('node:fs');
  try {
    switch (kind) {
      case 'wrong inode':
      case 'missing target':
        fs.renameSync(f.destination, elsewhere);
        if (kind === 'wrong inode') fs.writeFileSync(f.destination, 'user');
        break;
      case 'missing root':
        fs.renameSync(f.project, elsewhere);
        break;
      case 'three links':
        fs.linkSync(f.after, elsewhere);
        break;
      case 'symlink parent':
        fs.renameSync(dirname(f.destination), elsewhere);
        fs.symlinkSync(elsewhere, dirname(f.destination));
        break;
      case 'symlink file':
        fs.renameSync(f.destination, elsewhere);
        fs.symlinkSync(elsewhere, f.destination);
        break;
      case 'missing original':
        fs.renameSync(f.before, elsewhere);
        break;
      case 'next':
        fs.writeFileSync(f.main + '.next', '{');
        break;
      case 'completion next':
        fs.writeFileSync(f.main + '.next', JSON.stringify({ ...f.intent, status: 'completed' }));
        break;
      case 'malformed intent':
        fs.writeFileSync(f.main, 'synthetic-private-invalid-body');
        break;
      case 'completed':
        fs.writeFileSync(f.main, JSON.stringify({ ...f.intent, status: 'completed' }));
        break;
      case 'null after':
        fs.writeFileSync(f.main, JSON.stringify({ ...f.intent, after: null }));
        break;
      case 'foreign intent':
        fs.writeFileSync(f.main, JSON.stringify({ ...f.intent, path: 'private.key' }));
        break;
      case 'duplicate': {
        const other = id.replace('1', '2');
        fs.writeFileSync(
          join(f.files, other + '.json'),
          JSON.stringify({ ...f.intent, backup: other + '.before', staged: other + '.after' }),
        );
        break;
      }
      case 'before link':
        fs.linkSync(f.before, elsewhere);
        break;
      case 'main link':
        fs.linkSync(f.main, elsewhere);
        break;
      case 'header link':
        fs.linkSync(join(f.leaf, 'scope.json'), elsewhere);
        break;
      case 'mount':
        vi.mocked(fs.readFileSync).mockImplementation(((
          ...args: Parameters<typeof fs.readFileSync>
        ) => {
          const result = actual.readFileSync(...args),
            name = String(args[0]);
          return name.startsWith('/proc/self/fdinfo/') &&
            actual.realpathSync('/proc/self/fd/' + name.split('/').at(-1)) === f.destination &&
            typeof result === 'string'
            ? result.replace(/^mnt_id:\s+\d+$/m, 'mnt_id: 999999999')
            : result;
        }) as typeof fs.readFileSync);
        break;
    }
    const snapshot = () =>
      actual
        .readdirSync(f.outer, { recursive: true, encoding: 'utf8' })
        .sort()
        .map((rel) => {
          const p = join(f.outer, rel),
            s = actual.lstatSync(p);
          return [
            rel,
            s.ino,
            s.nlink,
            s.mode,
            s.isFile() ? actual.readFileSync(p) : s.isSymbolicLink() ? actual.readlinkSync(p) : '',
          ];
        });
    const initial = snapshot(),
      reads: string[] = [];
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      reads.push(actual.realpathSync('/proc/self/fd/' + args[0]));
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    const collect =
      kind === 'pending'
        ? () =>
            captureScopedCodingApplyRecovery(join(f.outer, 'common'), f.project, context, {
              ...app,
              files: [{ path: 'dir/file', status: 'pending' }],
            })
        : f.collect;
    expect(collect).toThrow(
      kind === 'malformed intent' ? 'invalid_coding_apply_recovery' : undefined,
    );
    expect(reads).not.toContain(f.after);
    expect(reads).not.toContain(f.destination);
    expect(snapshot()).toEqual(initial);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    f.close();
  }
});
