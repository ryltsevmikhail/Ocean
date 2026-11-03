import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
import { applyCodingFile } from './coding-apply-file.js';
const content = (text: string) => ({
  text,
  mode: '100644' as const,
  sha256: createHash('sha256').update(text).digest('hex'),
});
it.each(['destination', 'parent'])(
  'preserves user bytes when the %s changes after displacement',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-apply-race-'));
    const root = join(outer, 'root'),
      recovery = join(outer, 'recovery'),
      parent = join(root, 'dir');
    fs.mkdirSync(root);
    fs.mkdirSync(parent);
    fs.mkdirSync(recovery, { mode: 0o700 });
    fs.writeFileSync(join(parent, 'file'), 'old');
    try {
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
        actual.renameSync(from, to);
        if (kind === 'parent') {
          actual.renameSync(parent, join(root, 'detached'));
          fs.mkdirSync(parent);
        }
        fs.writeFileSync(join(parent, 'file'), 'user');
      });
      expect(() =>
        applyCodingFile(root, recovery, {
          path: 'dir/file',
          before: content('old'),
          after: content('new'),
        }),
      ).toThrow();
      expect(fs.readFileSync(join(parent, 'file'), 'utf8')).toBe('user');
      const backup = fs.readdirSync(recovery).find((name) => name.endsWith('.before'))!;
      expect(fs.readFileSync(join(recovery, backup), 'utf8')).toBe('old');
      const record = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
      expect(JSON.parse(fs.readFileSync(join(recovery, record), 'utf8'))).toMatchObject({
        status: 'started',
      });
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it('synchronizes retained original file data before reporting completed', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-apply-sync-'));
  const root = join(outer, 'root'),
    recovery = join(outer, 'recovery');
  fs.mkdirSync(root);
  fs.mkdirSync(recovery, { mode: 0o700 });
  fs.writeFileSync(join(root, 'file'), 'old');
  const synchronized: string[] = [];
  vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
    synchronized.push(fs.realpathSync('/proc/self/fd/' + String(fd)));
    actual.fsyncSync(fd);
  });
  try {
    applyCodingFile(root, recovery, {
      path: 'file',
      before: content('old'),
      after: content('new'),
    });
    expect(synchronized.some((path) => path.endsWith('.before'))).toBe(true);
    expect(fs.readFileSync(join(root, 'file'), 'utf8')).toBe('new');
  } finally {
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
