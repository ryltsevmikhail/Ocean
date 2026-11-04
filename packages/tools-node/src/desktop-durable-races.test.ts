import * as fs from 'node:fs';
import type * as cp from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const a = await original<typeof fs>();
  return {
    ...a,
    fstatSync: vi.fn(a.fstatSync),
    lstatSync: vi.fn(a.lstatSync),
    statSync: vi.fn(a.statSync),
    statfsSync: vi.fn(a.statfsSync),
    readFileSync: vi.fn(a.readFileSync),
    readSync: vi.fn(a.readSync),
    mkdirSync: vi.fn(a.mkdirSync),
    openSync: vi.fn(a.openSync),
  };
});
vi.mock('node:child_process', async (original) => {
  const a = await original<typeof cp>();
  return { ...a, spawnSync: vi.fn(a.spawnSync) };
});
import { desktopBootSimulation } from '../test-fixtures/desktop-boot.test.js';
import {
  imageAuthorityFixture,
  cleanupImageAuthorityRoots,
} from '../test-fixtures/desktop-image-authority.test.js';
import { desktopRead, importDesktopFile } from './desktop-file-store.js';
const closes: (() => void)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) close();
  const a = await vi.importActual<typeof fs>('node:fs');
  for (const key of [
    'fstatSync',
    'lstatSync',
    'statSync',
    'statfsSync',
    'readFileSync',
    'readSync',
    'mkdirSync',
    'openSync',
  ] as const)
    vi.mocked(fs[key]).mockImplementation(a[key] as never);
  cleanupImageAuthorityRoots();
});
async function fixture() {
  await desktopBootSimulation();
  const f = imageAuthorityFixture();
  closes.push(f.close);
  return { f, actual: await vi.importActual<typeof fs>('node:fs') };
}
it('refuses root replacement during import without publishing into the replacement tree', async () => {
  const { f, actual } = await fixture();
  const binding = f.binding();
  let replaced = false;
  vi.mocked(fs.mkdirSync).mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
    const result = actual.mkdirSync(...args);
    if (!replaced && String(args[0]).endsWith('/' + f.roomId)) {
      replaced = true;
      actual.renameSync(binding.root, binding.root + '-original');
      actual.mkdirSync(binding.root, { mode: 0o700 });
      actual.mkdirSync(join(binding.root, f.roomId), { mode: 0o700 });
    }
    return result;
  }) as typeof fs.mkdirSync);
  expect(() => importDesktopFile(binding, f.roomId, 'note.txt', 'aGVsbG8=')).toThrow();
  expect(replaced).toBe(true);
  expect(actual.readdirSync(join(binding.root, f.roomId))).toEqual([]);
});
it('pins the selected root before opening child metadata, refusing replacement before any child bytes', async () => {
  const { f, actual } = await fixture();
  const info = f.importImage(),
    binding = f.binding();
  let replaced = false,
    reads = 0;
  vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (!replaced && (path.endsWith('/' + info.id) || path.endsWith('/' + f.roomId))) {
      replaced = true;
      actual.renameSync(binding.root, binding.root + '-original');
      actual.cpSync(binding.root + '-original', binding.root, { recursive: true });
      actual.chmodSync(binding.root, 0o700);
    }
    return actual.openSync(...args);
  }) as typeof fs.openSync);
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() => desktopRead(binding, f.roomId, info.id)).toThrow();
  expect(replaced).toBe(true);
  expect(reads).toBe(0);
});
it.each(['linux-btrfs-v99:unknown', 'linux-btrfs-v1:malformed'])(
  'rejects archived identity %s before decoding attachment bodies',
  async (identity) => {
    const { f, actual } = await fixture();
    f.importImage();
    const { captureDesktopAssets, archiveDesktopAssets, verifyDesktopAssetArchive } =
      await import('./desktop-assets.js');
    const { createHash } = await import('node:crypto');
    const archive = join(f.root, 'archive');
    archiveDesktopAssets(captureDesktopAssets(f.store().desktopAssets.inventory(false)), archive);
    const path = join(archive, 'catalog.json');
    const catalog = JSON.parse(actual.readFileSync(path, 'utf8'));
    catalog.inventory.binding.identity = identity;
    const { hash: _hash, ...body } = catalog;
    catalog.hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    actual.writeFileSync(path, JSON.stringify(catalog));
    let bodies = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (actual.realpathSync('/proc/self/fd/' + String(args[0])).includes('/assets/blobs/'))
        bodies++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => verifyDesktopAssetArchive(archive)).toThrow();
    expect(bodies).toBe(0);
  },
);
