import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { graphFixture, digest } from '../test-fixtures/coding-recovery-graph.test.js';
import * as assets from './index.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
let f: ReturnType<typeof graphFixture>;
afterEach(() => {
  f?.close();
  vi.clearAllMocks();
});
const collect = (
  consume: Parameters<typeof assets.captureCodingRecoveryAssets>[2] = async () => {},
) => assets.captureCodingRecoveryAssets(f.inventory(), f.managed, consume);
it('covers two Git commons, exact unmarked v2 and ambiguous legacy candidates while excluding foreign bodies', async () => {
  f = graphFixture(2);
  const first = f.add('observed');
  f.scoped(first);
  f.add('legacy');
  const relevant = f.legacy(),
    mismatch = f.legacy(0, 'odd'),
    foreign = f.legacy(0, 'old', join(f.outer, 'foreign'));
  const header = f.add('header', 1, 2, 'uncertain');
  f.scoped(header, true);
  f.add('absent', 1, 2, 'uncertain');
  f.scoped(f.add('declared', 1, 2));
  const actual = await vi.importActual<typeof fs>('node:fs');
  const reads = new Set<string>();
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    reads.add(actual.realpathSync('/proc/self/fd/' + args[0]));
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  const hashes: string[] = [];
  try {
    const catalog = await collect(async ({ kind, capture }) => {
      hashes.push(
        assets.archiveCodingAssetTree(capture, join(f.outer, 'archive-' + hashes.length)).hash,
      );
      if (kind === 'legacy')
        expect(capture.manifest.selectedFiles).toEqual([
          basename(relevant).replace('.json', '.before'),
          basename(relevant),
        ]);
      Object.assign(capture.limits, { entries: 1 });
      Object.assign(capture.manifest, { hash: 'forged' });
    });
    expect(catalog.applications).toMatchObject([
      { id: 'observed', declaredProtocol: null, observedProtocol: 2, presence: 'scoped' },
      { id: 'legacy', declaredProtocol: null, observedProtocol: null, presence: 'absent' },
      { id: 'header', presence: 'header-only', unknown: ['file'] },
      { id: 'absent', presence: 'absent', unknown: ['file'] },
      { id: 'declared', presence: 'scoped' },
    ]);
    expect(catalog.legacy).toMatchObject([
      {
        records: [
          {
            id: basename(relevant, '.json'),
            candidateApplicationIds: ['observed', 'legacy'],
            ambiguous: true,
            original: 'matching',
          },
        ],
      },
    ]);
    expect(hashes).toHaveLength(4);
    expect(JSON.stringify(catalog)).not.toContain(basename(foreign, '.json'));
    for (const main of [mismatch, foreign]) {
      expect(reads.has(main)).toBe(true);
      expect(reads.has(main.replace('.json', '.before'))).toBe(false);
    }
    expect(first.recoveryProtocol).toBe(null);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  }
});
it('requires distinct finalized UUIDs and preserves every possible attribution', async () => {
  f = graphFixture();
  f.add('one');
  f.add('two');
  f.legacy();
  await expect(collect()).rejects.toThrow('invalid_coding_apply_recovery');
  f.legacy();
  const graph = await collect();
  expect(graph.legacy[0]!.records.map((r) => r.candidateApplicationIds)).toEqual([
    ['one', 'two'],
    ['one', 'two'],
  ]);
});
it.each([
  'missing',
  'next-missing',
  'next-only',
  'hash',
  'mode',
  'orphan',
  'foreign-header',
  'declared-substitution',
  'protected',
])('refuses %s even with otherwise available legacy evidence', async (kind) => {
  f = graphFixture();
  const app = f.add('app', 0, kind === 'declared-substitution' ? 2 : null),
    main = f.legacy(),
    body = JSON.parse(fs.readFileSync(main, 'utf8')),
    original = main.replace('.json', '.before');
  switch (kind) {
    case 'next-missing':
    case 'next-only':
      fs.writeFileSync(main + '.next', JSON.stringify(body), { mode: 0o600 });
      body.status = 'started';
      fs.writeFileSync(main, JSON.stringify(body));
      if (kind === 'next-missing') {
        Object.assign(app, { status: 'uncertain', files: [{ path: 'file', status: 'uncertain' }] });
        fs.unlinkSync(original);
      }
      break;
    case 'missing':
      fs.unlinkSync(original);
      break;
    case 'hash':
      body.after.sha256 = digest('bad');
      fs.writeFileSync(main, JSON.stringify(body));
      break;
    case 'mode':
      body.after.mode = ['100644'];
      fs.writeFileSync(main, JSON.stringify(body));
      break;
    case 'orphan':
      fs.unlinkSync(main);
      break;
    case 'protected':
      fs.symlinkSync(main, join(dirname(main), 'secret.key'));
      break;
    case 'foreign-header': {
      const leaf = f.scoped(app);
      fs.writeFileSync(
        join(leaf, 'scope.json'),
        fs.readFileSync(join(leaf, 'scope.json'), 'utf8').replace('ownerId', 'unknown'),
      );
      break;
    }
  }
  await expect(collect()).rejects.toThrow();
});
it('rechecks earlier source bytes and previously absent scopes after the last consumer', async () => {
  for (const kind of ['changed', 'appeared']) {
    f = graphFixture(2);
    const a = f.add('first', 0, 2, 'uncertain');
    const leaf = kind === 'changed' ? f.scoped(a) : null;
    f.scoped(f.add('later', 1, 2));
    await expect(
      collect(async ({ capture }) => {
        if (!capture.root.startsWith(f.worktrees[1]!.gitCommonDir)) return;
        if (leaf) {
          const files = join(leaf, 'files');
          fs.writeFileSync(
            join(
              files,
              fs.readdirSync(files).find((n) => n.endsWith('.before'))!,
            ),
            'bad',
          );
        } else f.scoped(a);
      }),
    ).rejects.toThrow();
    f.close();
  }
});
it('ignores unrelated legacy storage without eligible applications and verifies frozen hashes and bindings before reading bodies', async () => {
  f = graphFixture();
  fs.mkdirSync(join(f.worktrees[0]!.gitCommonDir, 'ocean-apply-recovery'));
  fs.writeFileSync(
    join(f.worktrees[0]!.gitCommonDir, 'ocean-apply-recovery', 'private.key'),
    'synthetic',
  );
  expect((await collect()).applications).toEqual([]);
  f.add('only', 0, 2, 'uncertain');
  expect((await collect()).legacy).toEqual([]);
  await expect(
    assets.captureCodingRecoveryAssets({ ...f.inventory(), hash: 'x' }, f.managed, async () => {}),
  ).rejects.toThrow();
  Object.assign(f.worktrees[0], { gitCommonDir: f.outer });
  await expect(collect()).rejects.toThrow();
});
it('distinguishes a declared protocol from an observed canonical header after a partial write', async () => {
  f = graphFixture();
  const app = f.add('partial', 0, 2, 'uncertain'),
    leaf = f.scoped(app, true);
  fs.writeFileSync(join(leaf, 'scope.json'), '{"vers');
  expect((await collect()).applications[0]).toMatchObject({
    declaredProtocol: 2,
    observedProtocol: null,
    presence: 'incomplete',
  });
});
it('binds the frozen file mode as well as the SHA256 for scoped and legacy matching', async () => {
  f = graphFixture();
  const app = f.add('uncertain', 0, null, 'uncertain'),
    main = f.legacy();
  const changed = JSON.parse(fs.readFileSync(main, 'utf8'));
  changed.after.mode = '100755';
  fs.writeFileSync(main, JSON.stringify(changed));
  expect((await collect()).legacy).toEqual([]);
  const leaf = f.scoped(app),
    files = join(leaf, 'files'),
    json = join(
      files,
      fs.readdirSync(files).find((n) => n.endsWith('.json'))!,
    );
  const scoped = JSON.parse(fs.readFileSync(json, 'utf8'));
  scoped.after.mode = '100755';
  fs.writeFileSync(json, JSON.stringify(scoped));
  await expect(collect()).rejects.toThrow('invalid_coding_apply_recovery');
});
it('charges classification bytes across commons before opening the over-budget JSON', async () => {
  f = graphFixture(2);
  f.add('a', 0, null, 'uncertain');
  f.add('b', 1, null, 'uncertain');
  const first = f.legacy(),
    pad = fs.readFileSync(first, 'utf8').padEnd(2097152, ' ');
  fs.writeFileSync(first, pad);
  const second = f.legacy(1),
    dir = dirname(second);
  fs.unlinkSync(second);
  fs.unlinkSync(second.replace('.json', '.before'));
  for (let i = 0; i < 128; i++) {
    const file = join(dir, '11111111-1111-1111-1111-' + String(i).padStart(12, '0') + '.json');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 2097152);
  }
  await expect(collect()).rejects.toThrow('coding_asset_limit');
});
it('rejects a smuggled Git admin path whose lexical dotdot normalization disagrees with filesystem resolution', async () => {
  f = graphFixture();
  f.add('only', 0, 2, 'uncertain');
  const tree = f.worktrees[0]!,
    pointer = join(tree.root, '.git'),
    original = fs.readFileSync(pointer, 'utf8').slice(8, -1);
  // The symlink changes how the kernel interprets "other/.."; Git would use a different admin directory.
  fs.mkdirSync(join(f.outer, 'elsewhere'));
  fs.symlinkSync(join(f.outer, 'elsewhere'), join(dirname(original), 'other'));
  fs.writeFileSync(
    pointer,
    'gitdir: ' + join(dirname(original), 'other') + '/../' + basename(original) + '\n',
  );
  await expect(collect()).rejects.toThrow('invalid_coding_inventory');
});
it('rechecks legacy directory privacy before the archive opens selected body bytes', async () => {
  f = graphFixture();
  f.add('legacy');
  const main = f.legacy();
  await expect(
    collect(async ({ capture }) => {
      fs.chmodSync(dirname(main), 0o755);
      vi.mocked(fs.readSync).mockClear();
      expect(() => assets.archiveCodingAssetTree(capture, join(f.outer, 'archive'))).toThrow();
      expect(fs.readSync).not.toHaveBeenCalled();
    }),
  ).rejects.toThrow('invalid_coding_apply_recovery');
});
