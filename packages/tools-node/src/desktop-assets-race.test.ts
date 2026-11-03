import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeSync: vi.fn(actual.writeSync),
  };
});
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  desktopRootIdentity,
} from './desktop-assets.js';
const roots: string[] = [];
afterEach(async () => {
  const a = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(a.readSync);
  vi.mocked(fs.readFileSync).mockImplementation(a.readFileSync);
  vi.mocked(fs.writeSync).mockImplementation(a.writeSync);
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-desktop-race-'));
  roots.push(root);
  const source = join(root, 'source'),
    room = 'room',
    id = '12345678-1234-4123-8123-123456789abc';
  fs.mkdirSync(join(source, room, id), { recursive: true, mode: 0o700 });
  const file = join(source, room, id, 'blob');
  fs.writeFileSync(file, 'hello', { mode: 0o600 });
  fs.writeFileSync(
    join(source, room, id, 'metadata.json'),
    JSON.stringify({
      id,
      name: 'notes.md',
      bytes: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
      kind: 'file',
      mime: 'text/plain',
    }),
    { mode: 0o600 },
  );
  const inventory = {
    format: 1 as const,
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
  };
  return { root, source, file, room, id, inventory };
}
it.each(['protected', 'hardlink', 'symlink', 'mount', 'budget'])(
  'preflights the full %s set before any source body read',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs'),
      f = fixture();
    if (kind === 'protected') fs.writeFileSync(join(f.source, 'z.env'), 'private', { mode: 0o600 });
    if (kind === 'hardlink') fs.linkSync(f.file, join(f.root, 'external'));
    if (kind === 'symlink') {
      fs.unlinkSync(f.file);
      fs.symlinkSync(join(f.root, 'external'), f.file);
    }
    if (kind === 'budget')
      for (let i = 0; i < 14; i++) {
        const dir = join(
          f.source,
          f.room,
          '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
        );
        fs.mkdirSync(dir, { mode: 0o700 });
        const fd = fs.openSync(join(dir, 'blob'), 'wx', 0o600);
        fs.ftruncateSync(fd, 10485760);
        fs.closeSync(fd);
      }
    if (kind === 'mount')
      vi.mocked(fs.readFileSync).mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        const value = actual.readFileSync(...args),
          path = String(args[0]);
        if (
          path.startsWith('/proc/self/fdinfo/') &&
          typeof value === 'string' &&
          actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === f.file
        )
          return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999');
        return value;
      }) as typeof fs.readFileSync);
    let bodies = 0;
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(f.source + '/')) bodies++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => captureDesktopAssets(f.inventory)).toThrow();
    expect(bodies).toBe(0);
  },
);
it('rehashes original source bytes after the last archive consumer despite unchanged mmap timestamps', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture();
  const child = spawn(
    '/usr/bin/python3',
    [
      '-I',
      '-S',
      '-c',
      `import mmap,sys
with open(sys.argv[1],'r+b') as file,mmap.mmap(file.fileno(),0,access=mmap.ACCESS_WRITE) as page:
 page[0]=page[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':page[:]=b'HELLO'`,
      f.file,
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
        HOME: f.root,
      },
    },
  );
  const exited = once(child, 'close');
  try {
    expect(String((await Promise.race([once(child.stdout, 'data'), exited]))[0]).trim()).toBe(
      'ready',
    );
    const identity = () => {
      const s = actual.statSync(f.file, { bigint: true });
      return [s.ino, s.size, s.mtimeNs, s.ctimeNs];
    };
    const before = identity(),
      capture = captureDesktopAssets(f.inventory);
    let changed = false;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      const n = actual.writeSync(...args);
      if (!changed && actual.realpathSync('/proc/self/fd/' + args[0]).includes('/assets/blobs/')) {
        child.stdin.write('!');
        const deadline = Date.now() + 3000,
          pause = new Int32Array(new SharedArrayBuffer(4));
        while (actual.readFileSync(f.file, 'utf8') !== 'HELLO' && Date.now() < deadline)
          Atomics.wait(pause, 0, 0, 1);
        expect(actual.readFileSync(f.file, 'utf8')).toBe('HELLO');
        expect(identity()).toEqual(before);
        changed = true;
      }
      return n;
    }) as typeof fs.writeSync);
    expect(() => archiveDesktopAssets(capture, join(f.root, 'archive'))).toThrow(
      'stale_coding_asset',
    );
    expect(changed).toBe(true);
    expect(actual.readFileSync(f.file, 'utf8')).toBe('HELLO');
  } finally {
    child.stdin.end();
    await exited;
  }
});
it('runtime authorized reads refuse a substituted child mount before metadata or blob bytes', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    f = fixture();
  const { desktopAssetFiles } = await import('./desktop-enrollment.js');
  const directory = join(f.source, f.room, f.id);
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      path = String(args[0]);
    if (
      path.startsWith('/proc/self/fdinfo/') &&
      typeof value === 'string' &&
      actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)).startsWith(directory)
    )
      return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999');
    return value;
  }) as typeof fs.readFileSync);
  let bodyReads = 0;
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(f.source + '/')) bodyReads++;
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() =>
    desktopAssetFiles('/synthetic', 'a'.repeat(64)).read(f.inventory.binding, f.room, f.id),
  ).toThrow();
  expect(bodyReads).toBe(0);
});
