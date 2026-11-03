import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { archiveCodingAssetTree, captureScopedCodingApplyRecovery } from './index.js';
import { app, context, publicationFixture } from '../test-fixtures/coding-publication.test.js';
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

it.each(['recapture', 'blob copy'])(
  'refuses a mapped duplicate sibling main before any staged %s read',
  async (phase) => {
    const actual = await vi.importActual<typeof fs>('node:fs'),
      f = publicationFixture();
    const otherId = '22222222-2222-2222-2222-222222222222',
      other = join(f.files, otherId + '.json');
    const prior = JSON.stringify({
      ...f.intent,
      path: 'dir/also',
      backup: otherId + '.before',
      staged: otherId + '.after',
    });
    const changed = prior.replace('dir/also', 'dir/file');
    actual.writeFileSync(other, prior, { mode: 0o600 });
    // Dirty a shared page before capture so a subsequent same-sized store keeps inode timestamps.
    const child = spawn(
      '/usr/bin/python3',
      [
        '-I',
        '-S',
        '-c',
        `
import mmap,sys
with open(sys.argv[1],'r+b') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as page:
 page[0]=page[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':
  page[:]=bytes.fromhex(sys.argv[2])
`,
        other,
        Buffer.from(changed).toString('hex'),
      ],
      {
        env: {
          ...Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ),
        },
      },
    );
    const exited = once(child, 'close');
    try {
      expect(String((await Promise.race([once(child.stdout, 'data'), exited]))[0]).trim()).toBe(
        'ready',
      );
      const identity = () => {
        const { ino, size, mtimeNs, ctimeNs } = actual.statSync(other, { bigint: true });
        return [ino, size, mtimeNs, ctimeNs];
      };
      const initial = identity();
      const captured = captureScopedCodingApplyRecovery(
        join(f.outer, 'common'),
        f.project,
        context,
        {
          ...app,
          files: [...app.files, { path: 'dir/also', status: 'uncertain' }],
        },
      ).capture!;
      let mutated = false,
        stagedReads = 0;
      const mutate = () => {
        child.stdin.write('!');
        const deadline = Date.now() + 3000,
          delay = new Int32Array(new SharedArrayBuffer(4));
        while (actual.readFileSync(other, 'utf8') !== changed && Date.now() < deadline)
          Atomics.wait(delay, 0, 0, 1);
        expect(actual.readFileSync(other, 'utf8')).toBe(changed);
        expect(identity()).toEqual(initial);
        mutated = true;
      };
      if (phase === 'recapture') mutate();
      vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
        const fd = actual.openSync(...args);
        if (!mutated && String(args[0]).endsWith('/.incomplete')) mutate();
        return fd;
      }) as typeof fs.openSync);
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (mutated && actual.realpathSync('/proc/self/fd/' + args[0]) === f.after) stagedReads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      expect(() => archiveCodingAssetTree(captured, join(f.outer, 'archive'))).toThrow(
        'stale_coding_asset',
      );
      expect(mutated).toBe(true);
      expect(stagedReads).toBe(0);
      expect(actual.readFileSync(f.before, 'utf8')).toBe('old');
      expect(actual.readFileSync(f.destination, 'utf8')).toBe('new');
      expect(actual.statSync(f.after).nlink).toBe(2);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      vi.mocked(fs.openSync).mockImplementation(actual.openSync);
      child.stdin.end();
      await exited;
      f.close();
    }
  },
);
it.each(['header', 'main'])(
  'keeps the publication target bound through the final post-staged %s hash',
  async (kind) => {
    const f = publicationFixture(),
      actual = await vi.importActual<typeof fs>('node:fs');
    const trigger = kind === 'header' ? join(f.leaf, 'scope.json') : f.main,
      detached = join(f.outer, 'detached-parent');
    let stagedReads = 0,
      renamed = false;
    try {
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actual.realpathSync('/proc/self/fd/' + args[0]);
        const count = actual.readSync(...args);
        if (path === f.after) stagedReads++;
        // Two staged body reads in each of the two capture passes and the final scope verification pass.
        if (!renamed && stagedReads === 6 && path === trigger) {
          actual.renameSync(join(f.project, 'dir'), detached);
          renamed = true;
        }
        return count;
      }) as typeof fs.readSync);
      expect(f.collect).toThrow();
      expect(renamed).toBe(true);
      expect(actual.existsSync(f.destination)).toBe(false);
      expect(actual.readFileSync(f.before, 'utf8')).toBe('old');
      expect(actual.readFileSync(join(detached, 'file'), 'utf8')).toBe('new');
      expect(actual.statSync(join(detached, 'file')).ino).toBe(actual.statSync(f.after).ino);
      expect(actual.statSync(f.after).nlink).toBe(2);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
