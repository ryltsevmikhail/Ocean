import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeSync: vi.fn(actual.writeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
  verifyDesktopAssetArchive,
  desktopRootIdentity,
} from './desktop-assets.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.openSync).mockImplementation(actual.openSync);
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
  vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(removeSource = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'o77-witness-'));
  roots.push(root);
  const source = join(root, 'source'),
    room = 'room',
    id = '12345678-1234-4123-8123-123456789abc';
  fs.mkdirSync(join(source, room, id), { recursive: true, mode: 0o700 });
  const sha256 = createHash('sha256').update('hello').digest('hex');
  fs.writeFileSync(join(source, room, id, 'blob'), 'hello', { mode: 0o600 });
  fs.writeFileSync(
    join(source, room, id, 'metadata.json'),
    JSON.stringify({ id, name: 'notes.md', bytes: 5, sha256, kind: 'file', mime: 'text/plain' }),
    { mode: 0o600 },
  );
  const archive = join(root, 'archive'),
    destination = join(root, 'restored');
  archiveDesktopAssets(
    captureDesktopAssets({
      format: 1,
      binding: {
        profileId: 'a'.repeat(64),
        root: source,
        originalRoot: source,
        identity: desktopRootIdentity(source),
      },
      rooms: [room],
      messages: [],
      operations: [],
      uploads: [],
    }),
    archive,
  );
  if (removeSource) fs.rmSync(source, { recursive: true });
  return { archive, destination, sha256, source };
}
it.each([
  ['assets', 'mode'],
  ['assets/blobs', 'mode'],
  ['assets', 'identity'],
  ['assets/blobs', 'identity'],
  ['assets', 'substitution'],
  ['assets/blobs', 'substitution'],
  ['', 'mode'],
  ['catalog.json', 'mode'],
  ['assets', 'mount'],
  ['assets/blobs', 'mount'],
  ['assets', 'current-mount'],
  ['assets/blobs', 'current-mount'],
  ['catalog.json', 'identity'],
  ['assets/manifest.json', 'identity'],
] as const)('retains original %s %s through the last verifier read', async (relative, kind) => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture(),
    target = join(f.archive, relative);
  let reads = 0,
    changed = false;
  const fresh = new Set<number>();
  vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = actual.openSync(...args);
    if (changed && String(args[0]) === target) fresh.add(fd);
    return fd;
  }) as typeof fs.openSync);
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      path = String(args[0]);
    if (
      changed &&
      (kind === 'mount' ||
        (kind === 'current-mount' && fresh.has(Number(path.split('/').at(-1))))) &&
      path.startsWith('/proc/self/fdinfo/') &&
      typeof value === 'string' &&
      actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === target
    )
      return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999');
    return value;
  }) as typeof fs.readFileSync);
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const n = actual.readSync(...args);
    if (
      actual.realpathSync('/proc/self/fd/' + args[0]) ===
        join(f.archive, 'assets', 'manifest.json') &&
      ++reads === 2
    ) {
      changed = true;
      if (kind === 'mode') actual.chmodSync(target, 0o755);
      if (kind === 'identity') actual.utimesSync(target, new Date(1000), new Date(1000));
      if (kind === 'substitution') {
        actual.renameSync(target, f.destination);
        actual.cpSync(f.destination, target, { recursive: true });
      }
    }
    return n;
  }) as typeof fs.readSync);
  expect(() => verifyDesktopAssetArchive(f.archive)).toThrow();
  expect(changed).toBe(true);
  if (kind === 'current-mount') expect(fresh.size).toBeGreaterThan(0);
});
it.each(['assets', 'assets/blobs', 'catalog.json', 'assets/manifest.json', 'blob'])(
  'retains original %s witnesses across materialization, not a fresh verification baseline',
  async (relative) => {
    const actual = await vi.importActual<typeof fs>('node:fs'),
      f = fixture();
    const target = join(f.archive, relative === 'blob' ? 'assets/blobs/' + f.sha256 : relative);
    let changed = false;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      const n = actual.writeSync(...args);
      if (
        !changed &&
        actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(f.destination + '/tree/')
      ) {
        actual.utimesSync(target, new Date(1000), new Date(1000));
        changed = true;
      }
      return n;
    }) as typeof fs.writeSync);
    expect(() => restoreDesktopAssets(f.archive, f.destination)).toThrow();
    expect(changed).toBe(true);
  },
);
it('checks original private directories after the evidence-file publication consumer', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture();
  let changed = false;
  vi.mocked(fs.writeFileSync).mockImplementation(((
    ...args: Parameters<typeof fs.writeFileSync>
  ) => {
    const result = actual.writeFileSync(...args);
    if (
      typeof args[0] === 'number' &&
      actual.realpathSync('/proc/self/fd/' + args[0]) ===
        join(f.destination, 'desktop-evidence.json')
    ) {
      actual.chmodSync(join(f.archive, 'assets'), 0o755);
      changed = true;
    }
    return result;
  }) as typeof fs.writeFileSync);
  expect(() => restoreDesktopAssets(f.archive, f.destination)).toThrow();
  expect(changed).toBe(true);
});

it('keeps archive witnesses through the final original-source validation consumer', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture(false);
  const old = verifyDesktopAssetArchive(f.archive);
  const capture = captureDesktopAssets(old.inventory);
  const next = join(f.destination, '..', 'next');
  let publishedReads = 0,
    changed = false;
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const n = actual.readSync(...args),
      path = actual.realpathSync('/proc/self/fd/' + args[0]);
    if (path === join(next, 'catalog.json') && !actual.existsSync(join(next, '.incomplete')))
      publishedReads++;
    if (!changed && publishedReads >= 2 && path.startsWith(f.source + '/')) {
      actual.chmodSync(join(next, 'assets'), 0o755);
      changed = true;
    }
    return n;
  }) as typeof fs.readSync);
  expect(() => archiveDesktopAssets(capture, next)).toThrow();
  expect(changed).toBe(true);
});
it('pins the same directory stat that passed private validation, without a later baseline', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture();
  const target = join(f.archive, 'assets');
  let observations = 0,
    changed = false;
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      path = String(args[0]);
    if (
      path.startsWith('/proc/self/fdinfo/') &&
      actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === target &&
      ++observations === 2
    ) {
      actual.chmodSync(target, 0o755);
      changed = true;
    }
    return value;
  }) as typeof fs.readFileSync);
  expect(() => verifyDesktopAssetArchive(f.archive)).toThrow();
  expect(changed).toBe(true);
});
