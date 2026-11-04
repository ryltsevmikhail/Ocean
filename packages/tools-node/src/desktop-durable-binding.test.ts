import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { join } from 'node:path';
import { DesktopAssetService } from '@runnets/application';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    statfsSync: vi.fn(actual.statfsSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof cp>()),
  spawnSync: vi.fn(),
}));
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
} from './desktop-assets.js';
import { desktopRead, readDesktopPreparation } from './desktop-file-store.js';
import {
  imageAuthorityFixture,
  cleanupImageAuthorityRoots,
  persistMessage,
  resolveAuthority,
  expectedFor,
  PNG,
} from '../test-fixtures/desktop-image-authority.test.js';
const requestId = '22345678-1234-4123-8123-123456789abc';
const anchor = {
  filesystem: '11111111111111111111111111111111',
  subvolume: '22222222222222222222222222222222',
  subvolumeId: '257',
  type: 77,
  handle: '00112233445566778899aabbccddeeff00112233',
};
const close: (() => void)[] = [];
afterEach(async () => {
  for (const release of close.splice(0)) release();
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof fs>('node:fs');
  for (const key of [
    'fstatSync',
    'lstatSync',
    'statSync',
    'statfsSync',
    'readFileSync',
    'readSync',
  ] as const)
    vi.mocked(fs[key]).mockImplementation(actual[key] as never);
  cleanupImageAuthorityRoots();
});
async function fixture() {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.statfsSync).mockImplementation((() => ({
    type: 0x9123683e,
  })) as typeof fs.statfsSync);
  vi.mocked(cp.spawnSync).mockImplementation((() => ({
    status: 0,
    signal: null,
    stdout: JSON.stringify(anchor),
    stderr: '',
  })) as typeof cp.spawnSync);
  const f = imageAuthorityFixture();
  close.push(f.close);
  const info = f.importImage();
  const receipt = f.prepare(requestId, 'photo', [info.id]);
  persistMessage(f, { id: 'message', body: receipt.prepared, requestId });
  return { f, actual, info, receipt };
}
async function drift(device: boolean, mount: boolean) {
  const actual = await vi.importActual<typeof fs>('node:fs');
  if (device) {
    for (const key of ['fstatSync', 'lstatSync', 'statSync'] as const)
      vi.mocked(fs[key]).mockImplementation(((...args: unknown[]) => {
        const s = Reflect.apply(actual[key], actual, args) as fs.BigIntStats;
        s.dev =
          typeof s.dev === 'bigint' ? s.dev + 99n : ((Number(s.dev) + 99) as unknown as bigint);
        return s;
      }) as never);
  }
  if (mount)
    vi.mocked(fs.readFileSync).mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const value = actual.readFileSync(...args);
      return String(args[0]).startsWith('/proc/self/fdinfo/') && typeof value === 'string'
        ? value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t987654')
        : value;
    }) as typeof fs.readFileSync);
}
it.each([
  [true, false],
  [false, true],
  [true, true],
])(
  'keeps read, preparation, historical images and backup authoritative after device=%s mount=%s drift',
  async (device, mount) => {
    const { f, info, receipt } = await fixture();
    const original = f.binding();
    await drift(device, mount);
    f.reopen();
    expect(desktopRead(f.binding(), f.roomId, info.id).data.toString('base64')).toBe(PNG);
    expect(readDesktopPreparation(f.binding(), f.roomId, requestId)).toEqual(receipt);
    expect(
      new DesktopAssetService(f.store().desktopAssets, f.files).prepare(
        f.roomId,
        '32345678-1234-4123-8123-123456789abc',
        'again',
        null,
        [info.id],
      ).ids,
    ).toEqual([info.id]);
    expect(
      resolveAuthority(f, {
        messageId: 'message',
        body: receipt.prepared,
        requestId,
        expected: expectedFor(info),
      }),
    ).toMatchObject({ ok: true });
    const archive = join(f.root, 'archive');
    archiveDesktopAssets(captureDesktopAssets(f.store().desktopAssets.inventory(false)), archive);
    expect(f.binding()).toEqual(original);
    fs.rmSync(original.root, { recursive: true });
    restoreDesktopAssets(archive, join(f.root, 'restored'));
    expect(
      fs.readFileSync(join(f.root, 'restored/tree', f.roomId, info.id, 'blob')).toString('base64'),
    ).toBe(PNG);
  },
);
it.each(['filesystem', 'subvolume', 'subvolumeId', 'type', 'handle'] as const)(
  'refuses a changed persistent %s before body reads',
  async (key) => {
    const { f, info, actual } = await fixture();
    const changed = {
      ...anchor,
      [key]: key === 'type' ? 78 : key === 'subvolumeId' ? '258' : 'f'.repeat(anchor[key].length),
    };
    vi.mocked(cp.spawnSync).mockImplementation((() => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify(changed),
      stderr: '',
    })) as typeof cp.spawnSync);
    let reads = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      reads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => desktopRead(f.binding(), f.roomId, info.id)).toThrow('desktop_binding_mismatch');
    expect(reads).toBe(0);
  },
);
it('refuses unavailable or malformed helper evidence without downgrading an anchored binding', async () => {
  const { f, info } = await fixture();
  for (const result of [
    { status: null, error: Error('ENOENT'), stdout: '', stderr: '' },
    { status: 1, stdout: '', stderr: 'unsupported' },
    { status: 0, stdout: '{}', stderr: '' },
    { status: 0, stdout: JSON.stringify({ ...anchor, extra: true }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ ...anchor, handle: 'a'.repeat(258) }), stderr: '' },
  ]) {
    vi.mocked(cp.spawnSync).mockReturnValue(result as ReturnType<typeof cp.spawnSync>);
    expect(() => desktopRead(f.binding(), f.roomId, info.id)).toThrow();
  }
});
it.each(['uid', 'gid', 'mode'] as const)(
  'refuses changed root %s before body reads',
  async (field) => {
    const { f, info, actual } = await fixture();
    for (const key of ['fstatSync', 'lstatSync', 'statSync'] as const)
      vi.mocked(fs[key]).mockImplementation(((...args: unknown[]) => {
        const stat = Reflect.apply(actual[key], actual, args) as fs.BigIntStats;
        const value = typeof stat[field] === 'bigint' ? stat[field] : BigInt(stat[field]);
        stat[field] = (
          typeof stat[field] === 'bigint'
            ? field === 'mode'
              ? 16872n
              : value + 1n
            : Number(field === 'mode' ? 16872n : value + 1n)
        ) as bigint;
        return stat;
      }) as never);
    let reads = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      reads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => desktopRead(f.binding(), f.roomId, info.id)).toThrow();
    expect(reads).toBe(0);
  },
);
it('keeps unsupported filesystems in exact legacy mode and refuses later drift', async () => {
  const { f } = await fixture();
  const { desktopBindingIdentity } = await import('./desktop-root.js');
  vi.mocked(fs.statfsSync).mockImplementation((() => ({
    type: 0x1021994,
  })) as typeof fs.statfsSync);
  const binding = { ...f.binding(), identity: desktopBindingIdentity(f.binding().root) };
  expect(binding.identity).toMatch(/^\d+(?::\d+){5}$/);
  await drift(true, true);
  expect(() =>
    captureDesktopAssets({ ...f.store().desktopAssets.inventory(false), binding }),
  ).toThrow('desktop_binding_mismatch');
});
it('never downgrades an anchored binding when its filesystem becomes unsupported', async () => {
  const { f, info } = await fixture();
  vi.mocked(fs.statfsSync).mockImplementation((() => ({
    type: 0x1021994,
  })) as typeof fs.statfsSync);
  expect(() => desktopRead(f.binding(), f.roomId, info.id)).toThrow('desktop_binding_mismatch');
});
it('rechecks the full root witness after the helper before reading child bodies', async () => {
  const { f, info, actual } = await fixture();
  vi.mocked(cp.spawnSync).mockImplementation((() => {
    actual.writeFileSync(join(f.binding().root, 'changed'), 'synthetic', { mode: 0o600 });
    return { status: 0, signal: null, stdout: JSON.stringify(anchor), stderr: '' };
  }) as typeof cp.spawnSync);
  let reads = 0;
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() => desktopRead(f.binding(), f.roomId, info.id)).toThrow('desktop_binding_mismatch');
  expect(reads).toBe(0);
});
