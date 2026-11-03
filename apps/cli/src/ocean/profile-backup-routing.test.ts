import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
import { restoreProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('refuses an oversized public snapshot before any body allocation/read or destination creation', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-routing-'));
  roots.push(root);
  const archive = join(root, 'archive'),
    target = join(root, 'quarantine');
  fs.mkdirSync(archive, { mode: 0o700 });
  const manifest = join(archive, 'snapshot.json'),
    fd = fs.openSync(manifest, 'wx', 0o600);
  fs.ftruncateSync(fd, 33554433);
  fs.closeSync(fd);
  const actual = await vi.importActual<typeof fs>('node:fs');
  let reads = 0;
  const check = (path: unknown) => {
    if (
      (typeof path === 'number' ? actual.realpathSync('/proc/self/fd/' + path) : String(path)) ===
      manifest
    ) {
      reads++;
      throw Error('forbidden oversized body allocation');
    }
  };
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    check(args[0]);
    return actual.readFileSync(...args);
  }) as typeof fs.readFileSync);
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    check(args[0]);
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() => restoreProfile(archive, target)).toThrow('invalid_backup');
  expect(reads).toBe(0);
  expect(fs.existsSync(target)).toBe(false);
});
