import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { dependencyFixture } from '../test-fixtures/coding-dependencies.test.js';
import { captureCodingDependencyAssets } from './coding-dependency-graph.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
it.each(['secret-alias', 'protected', 'unknown-mount', 'fifo', 'later-root-secret'])(
  'refuses %s before any dependency body read',
  async (kind) => {
    const f = dependencyFixture(),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      const trees = f.trees();
      if (kind === 'secret-alias')
        fs.linkSync(join(f.deps, 'node_modules/pkg'), join(f.outer, 'credential'));
      if (kind === 'protected') fs.writeFileSync(join(f.deps, 'node_modules/.npmrc'), 'synthetic');
      if (kind === 'unknown-mount')
        f.registry[0]!.mounts.push({ source: f.outer, target: '/host' });
      if (kind === 'fifo') {
        const { execFileSync } = await import('node:child_process');
        execFileSync('mkfifo', [join(f.deps, 'node_modules/pipe')], {
          env: { PATH: process.env['PATH'], HOME: process.env['HOME'] },
        });
      }
      if (kind === 'later-root-secret') {
        fs.mkdirSync(join(f.deps, 'other/node_modules'), { recursive: true });
        fs.writeFileSync(join(f.deps, 'other/node_modules/.env'), 'synthetic');
        f.registry[0]!.mounts.push({
          source: join(f.deps, 'other/node_modules'),
          target: '/workspace/other/node_modules',
        });
      }
      f.save();
      let reads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actual.realpathSync('/proc/self/fd/' + args[0]);
        if (path.startsWith(f.deps + '/') || path.startsWith(f.bin + '/')) reads++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      await expect(
        captureCodingDependencyAssets(f.inventory(), f.profile, trees, async () => {}),
      ).rejects.toThrow();
      expect(reads).toBe(0);
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
it('detects a changed mount identity after the last consumer', async () => {
  const f = dependencyFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  let changed = false;
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      path = String(args[0]);
    if (
      changed &&
      path.startsWith('/proc/self/fdinfo/') &&
      typeof value === 'string' &&
      actual.readlinkSync('/proc/self/fd/' + path.split('/').at(-1)).startsWith(f.deps)
    )
      return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t99999999');
    return value;
  }) as typeof fs.readFileSync);
  try {
    await expect(
      captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
        changed = true;
      }),
    ).rejects.toThrow('stale_coding_asset');
  } finally {
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    f.close();
  }
});
it.each([
  'registry-mode',
  'registry-link',
  'profile-replacement',
  'config-replacement',
  'unselected-config',
])('refuses changed ownership or binding: %s', async (kind) => {
  const f = dependencyFixture();
  try {
    if (kind === 'registry-mode') fs.chmodSync(join(f.profile, 'coding-projects.json'), 0o644);
    if (kind === 'registry-link')
      fs.linkSync(join(f.profile, 'coding-projects.json'), join(f.outer, 'registry-alias'));
    await expect(
      captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
        if (kind === 'profile-replacement') {
          fs.renameSync(f.profile, f.profile + '-old');
          fs.mkdirSync(f.profile, { mode: 0o700 });
          f.save();
        }
        if (kind === 'config-replacement') {
          fs.renameSync(join(f.profile, 'coding-projects.json'), join(f.profile, 'old'));
          f.save();
        }
        if (kind === 'unselected-config') {
          f.registry[1]!.id = 'changed-unselected';
          f.save();
        }
      }),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});
it('charges internal hardlink logical bytes before opening any dependency body', async () => {
  const f = dependencyFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  try {
    const path = join(f.deps, 'node_modules/large');
    fs.writeFileSync(path, '');
    fs.truncateSync(path, 1073741824);
    fs.linkSync(path, join(f.deps, 'node_modules/large2'));
    fs.linkSync(path, join(f.deps, 'node_modules/large3'));
    let reads = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (actual.readlinkSync('/proc/self/fd/' + args[0]).startsWith(f.deps + '/')) {
        reads++;
        throw Error('unexpected body read');
      }
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    await expect(
      captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {}),
    ).rejects.toThrow('coding_asset_limit');
    expect(reads).toBe(0);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    f.close();
  }
});
it('pins dependency mapping-root mount identity independently of each selected child', async () => {
  const f = dependencyFixture(),
    actual = await vi.importActual<typeof fs>('node:fs');
  let changed = false;
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      path = String(args[0]);
    if (
      changed &&
      path.startsWith('/proc/self/fdinfo/') &&
      typeof value === 'string' &&
      actual.readlinkSync('/proc/self/fd/' + path.split('/').at(-1)) === f.deps
    )
      return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t99999999');
    return value;
  }) as typeof fs.readFileSync);
  try {
    await expect(
      captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
        changed = true;
      }),
    ).rejects.toThrow('stale_coding_asset');
  } finally {
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    f.close();
  }
});
it('rechecks explicit configuration absence without reading unselected profile files', async () => {
  const f = dependencyFixture();
  try {
    const { holdCodingConfiguration } = await import('./coding-dependency-config.js');
    fs.unlinkSync(join(f.profile, 'coding-projects.json'));
    fs.writeFileSync(join(f.profile, 'saved-key'), 'synthetic canary');
    const held = holdCodingConfiguration(f.profile);
    try {
      expect(held.configuration.presence).toBe('absent');
      f.save();
      expect(() => held.verify()).toThrow('stale_coding_asset');
    } finally {
      held.close();
    }
  } finally {
    f.close();
  }
});
it.each(['profile', 'dependency', 'mapping', 'toolchain'])(
  'compares newly opened pathname mount with pinned %s descriptor after consumers',
  async (kind) => {
    const f = dependencyFixture(),
      actual = await vi.importActual<typeof fs>('node:fs'),
      fresh = new Set<number>();
    let changed = false,
      count = 0;
    const target =
      kind === 'profile'
        ? f.profile
        : kind === 'mapping'
          ? f.deps
          : kind === 'toolchain'
            ? f.bin
            : join(f.deps, 'node_modules');
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = actual.openSync(...args);
      if (changed && String(args[0]) === target) fresh.add(fd);
      else fresh.delete(fd);
      return fd;
    });
    vi.mocked(fs.readFileSync).mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const value = actual.readFileSync(...args),
        path = String(args[0]);
      if (
        path.startsWith('/proc/self/fdinfo/') &&
        fresh.has(Number(path.split('/').at(-1))) &&
        typeof value === 'string'
      )
        return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t99999999');
      return value;
    }) as typeof fs.readFileSync);
    try {
      await expect(
        captureCodingDependencyAssets(f.inventory(), f.profile, f.trees(), async () => {
          if (++count === 2) changed = true;
        }),
      ).rejects.toThrow('stale_coding_asset');
    } finally {
      vi.mocked(fs.openSync).mockImplementation(actual.openSync);
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      f.close();
    }
  },
);
