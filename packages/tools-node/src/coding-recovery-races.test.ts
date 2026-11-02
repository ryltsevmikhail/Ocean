import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import {
  captureCodingRecoveryAssets,
  captureCodingAssetFiles,
  archiveCodingAssetTree,
} from './index.js';
import { graphFixture } from '../test-fixtures/coding-recovery-graph.test.js';
/** Dirty the mapping once before observation. A second store can preserve inode, size, mtime and ctime. */
async function mapped(
  path: string,
  replacement: string,
  run: (mutate: () => Promise<void>) => Promise<void>,
) {
  const script = `import sys,mmap
with open(sys.argv[1],'r+b') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as p:
 p[0]=p[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':
  p[:]=bytes.fromhex(sys.argv[2])
  print('changed',flush=True)`;
  const child = spawn(
    '/usr/bin/python3',
    ['-I', '-S', '-c', script, path, Buffer.from(replacement).toString('hex')],
    { env: {} },
  );
  const closed = once(child, 'close');
  const identity = () => {
    const { ino, size, mtimeNs, ctimeNs } = fs.statSync(path, { bigint: true });
    return [ino, size, mtimeNs, ctimeNs];
  };
  try {
    expect(String((await Promise.race([once(child.stdout, 'data'), closed]))[0]).trim()).toBe(
      'ready',
    );
    const before = identity();
    await run(async () => {
      const output = once(child.stdout, 'data');
      child.stdin.write('!');
      expect(String((await Promise.race([output, closed]))[0]).trim()).toBe('changed');
      expect(identity()).toEqual(before);
      expect(fs.readFileSync(path, 'utf8')).toBe(replacement);
    });
  } finally {
    child.stdin.end();
    await closed;
  }
}
it.each([true, false])(
  'rehashes earlier unmatched JSON after a shared-mapping write, new membership=%s',
  async (becomesMatching) => {
    const f = graphFixture(2);
    try {
      f.add('earlier');
      f.add('later', 1);
      f.legacy();
      f.legacy(1);
      const foreignRoot = f.tasks[0]!.projectRoot.replace('project0', 'foreign0');
      const foreign = f.legacy(0, 'old', foreignRoot),
        next = fs
          .readFileSync(foreign, 'utf8')
          .replace(
            foreignRoot,
            becomesMatching ? f.tasks[0]!.projectRoot : foreignRoot.replace('foreign0', 'foreign1'),
          );
      await mapped(foreign, next, async (mutate) => {
        await expect(
          captureCodingRecoveryAssets(f.inventory(), f.managed, async ({ capture }) => {
            if (capture.root.startsWith(f.worktrees[1]!.gitCommonDir)) await mutate();
          }),
        ).rejects.toThrow('stale_coding_asset');
      });
    } finally {
      f.close();
    }
  },
);
it.each([true, false])(
  'rechecks legacy membership after consuming the last common, previously absent=%s',
  async (absent) => {
    const f = graphFixture(2);
    try {
      f.add('earlier', 0, null, 'uncertain');
      if (!absent) f.legacy();
      f.add('later', 1);
      f.legacy(1);
      await expect(
        captureCodingRecoveryAssets(f.inventory(), f.managed, async ({ capture }) => {
          if (capture.root.startsWith(f.worktrees[1]!.gitCommonDir)) f.legacy();
        }),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  },
);
it('rechecks selected file bytes before archive even with stable source identity', async () => {
  const f = graphFixture();
  try {
    const root = f.tasks[0]!.projectRoot,
      path = join(root, 'file');
    await mapped(path, 'bad', async (mutate) => {
      const capture = captureCodingAssetFiles(root, ['file']);
      await mutate();
      expect(() => archiveCodingAssetTree(capture, join(f.outer, 'archive'))).toThrow(
        'stale_coding_asset',
      );
    });
  } finally {
    f.close();
  }
});
it('retains interrupted legacy staged bytes linked to the checkout without following or materializing the external alias', async () => {
  const f = graphFixture();
  try {
    f.add('started', 0, null, 'uncertain');
    const main = f.legacy(),
      intent = JSON.parse(fs.readFileSync(main, 'utf8'));
    fs.writeFileSync(main, JSON.stringify({ ...intent, status: 'started' }));
    const staged = main.replace('.json', '.after');
    fs.linkSync(join(f.tasks[0]!.projectRoot, 'file'), staged);
    const graph = await captureCodingRecoveryAssets(
      f.inventory(),
      f.managed,
      async ({ capture }) => {
        expect(
          capture.manifest.entries.some((e) => e.path === intent.staged && e.kind === 'file'),
        ).toBe(true);
        archiveCodingAssetTree(capture, join(f.outer, 'archive'));
      },
    );
    expect(graph.legacy[0]?.records[0]?.status).toBe('started');
    expect(fs.statSync(staged).nlink).toBe(2);
  } finally {
    f.close();
  }
});
it.each(['mapped staged body', 'missing project alias'])(
  'refuses a changed %s after the last graph consumer',
  async (kind) => {
    const f = graphFixture(2);
    try {
      const app = f.add('publication', 0, 2, 'uncertain'),
        files = join(f.scoped(app), 'files');
      const main = join(
        files,
        fs.readdirSync(files).find((name) => name.endsWith('.json'))!,
      );
      fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('"completed"', '"started"'));
      const stage = main.replace('.json', '.after'),
        target = join(f.tasks[0]!.projectRoot, 'file');
      fs.linkSync(target, stage);
      const later = f.scoped(f.add('later', 1, 2));
      await mapped(stage, 'bad', async (mutate) => {
        let consumed = false;
        await expect(
          captureCodingRecoveryAssets(f.inventory(), f.managed, async ({ capture }) => {
            if (capture.root !== later) return;
            consumed = true;
            if (kind === 'mapped staged body') await mutate();
            else fs.renameSync(target, join(f.outer, 'user-file'));
          }),
        ).rejects.toThrow();
        expect(consumed).toBe(true);
        expect(fs.readFileSync(stage, 'utf8')).toBe(kind === 'mapped staged body' ? 'bad' : 'new');
        expect(fs.statSync(stage).nlink).toBe(2);
      });
    } finally {
      f.close();
    }
  },
);
