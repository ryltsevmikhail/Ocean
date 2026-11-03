import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { dependencyFixture } from '../test-fixtures/coding-dependencies.test.js';
import { captureCodingDependencyAssets } from './coding-dependency-graph.js';
it.each(['registry', 'dependency', 'toolchain', 'task'] as const)(
  'rehashes %s after unchanged-timestamp shared-memory mutation',
  async (kind) => {
    const f = dependencyFixture();
    const path =
      kind === 'registry'
        ? join(f.profile, 'coding-projects.json')
        : kind === 'dependency'
          ? join(f.deps, 'node_modules/pkg')
          : kind === 'toolchain'
            ? join(f.bin, 'pnpm')
            : join(f.tree, 'packages/local/index.js');
    const child = spawn(
      '/usr/bin/python3',
      [
        '-I',
        '-S',
        '-c',
        `import sys,mmap
with open(sys.argv[1],'r+b') as f,mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as p:
 p[0]=p[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':
  p[0]=88
  print('changed',flush=True)`,
        path,
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
          HOME: process.env['HOME'],
        },
      },
    );
    const closed = once(child, 'close');
    try {
      expect(String((await Promise.race([once(child.stdout, 'data'), closed]))[0]).trim()).toBe(
        'ready',
      );
      const identity = () => {
        const { ino, size, mtimeNs, ctimeNs } = fs.statSync(path, { bigint: true });
        return [ino, size, mtimeNs, ctimeNs];
      };
      const before = identity();
      let count = 0;
      await expect(
        captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
          if (++count !== 2) return;
          const output = once(child.stdout, 'data');
          child.stdin.write('!');
          expect(String((await Promise.race([output, closed]))[0]).trim()).toBe('changed');
          expect(identity()).toEqual(before);
        }),
      ).rejects.toThrow('stale_coding_asset');
    } finally {
      child.stdin.end();
      await closed;
      f.close();
    }
  },
);
it('retains incomplete output and unchanged originals when a consumer fails', async () => {
  const f = dependencyFixture();
  try {
    const before = fs.readFileSync(join(f.bin, 'pnpm'));
    await expect(
      captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
        fs.mkdirSync(join(f.outer, 'incomplete'));
        throw Error('copy failed');
      }),
    ).rejects.toThrow('copy failed');
    expect(fs.existsSync(join(f.outer, 'incomplete'))).toBe(true);
    expect(fs.readFileSync(join(f.bin, 'pnpm'))).toEqual(before);
  } finally {
    f.close();
  }
});
it.each(['external-hardlink', 'replacement-file'])(
  'refuses last-consumer task %s before reading replacement bytes',
  async (kind) => {
    const f = dependencyFixture(),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      const trees = f.trees(),
        path = join(f.tree, 'packages/local/index.js'),
        canary = join(f.outer, 'synthetic-credential');
      fs.writeFileSync(canary, 'synthetic private bytes');
      const inode = fs.statSync(canary).ino;
      let reads = 0,
        count = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (actual.fstatSync(args[0]).ino === inode) reads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      await expect(
        captureCodingDependencyAssets(f.inventory(), f.profile, trees, async () => {
          if (++count !== 2) return;
          fs.unlinkSync(path);
          if (kind === 'external-hardlink') fs.linkSync(canary, path);
          else fs.renameSync(canary, path);
        }),
      ).rejects.toThrow('stale_coding_asset');
      expect(count).toBe(2);
      expect(reads).toBe(0);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
