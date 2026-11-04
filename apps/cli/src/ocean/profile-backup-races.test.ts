import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { snapshotCodingDatabase } from '@runnets/store-sqlite';
import { captureProfileBackupAssets } from '@runnets/tools-node';
import { fullBackupFixture, byteHash } from '../../test-fixtures/profile-backup.test.js';
import { emptyPluginBackupInventory } from '@runnets/domain';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function environment() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-races-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  return root;
}
it.each(['combined', 'hardlink-logical'])(
  'refuses the wholegraph %s lower ceiling before selected bodies',
  async (kind) => {
    const root = environment(),
      f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      const body = join(f.worktree, 'budget.bin'),
        blob = join(f.desktop, f.room, f.id, 'blob');
      fs.writeFileSync(body, Buffer.alloc(kind === 'combined' ? 12000 : 20000, 97));
      if (kind === 'hardlink-logical') {
        fs.linkSync(body, join(f.worktree, 'budget2.bin'));
        fs.linkSync(body, join(f.worktree, 'budget3.bin'));
      } else {
        const bytes = Buffer.alloc(32000, 98),
          infoPath = join(f.desktop, f.room, f.id, 'metadata.json'),
          info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        info.bytes = bytes.length;
        info.sha256 = byteHash(bytes);
        fs.writeFileSync(blob, bytes);
        fs.writeFileSync(infoPath, JSON.stringify(info));
        const receiptPath = join(f.desktop, f.room, f.request + '.json'),
          receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        receipt.prepared =
          'caption\n\n[Ocean Desktop attachments v1]\n' +
          JSON.stringify({ version: 1, requestId: f.request, files: [info] });
        receipt.digest = byteHash(receipt.prepared);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
        try {
          db.prepare('UPDATE ocean_desktop_operations SET result=?').run(JSON.stringify(receipt));
        } finally {
          db.close();
        }
      }
      let bodies = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const path = actual.realpathSync('/proc/self/fd/' + args[0]);
        if ([body, blob].includes(path)) bodies++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      const frozen = join(root, 'frozen.sqlite'),
        archive = join(root, 'assets');
      await expect(
        snapshotCodingDatabase(
          join(f.directory, 'runtime.sqlite'),
          frozen,
          async (inventory, desktop) =>
            captureProfileBackupAssets(
              {
                inventory,
                desktop,
                plugins: emptyPluginBackupInventory(),
                profile: f.directory,
                managed: join(f.directory, 'worktrees'),
                databaseBytes: fs.statSync(frozen).size,
              },
              archive,
              undefined,
              { logical: fs.statSync(frozen).size + 90000 },
            ),
        ),
      ).rejects.toThrow('profile_backup_limit');
      expect(bodies).toBe(0);
      expect(fs.existsSync(archive)).toBe(false);
    } finally {
      f.close();
    }
  },
);
it.each(['tree', 'git-index', 'configuration', 'replacement'])(
  'retains original %s witnesses through the final wholegraph consumer',
  async (kind) => {
    const root = environment(),
      f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false),
      actual = await vi.importActual<typeof fs>('node:fs');
    try {
      const frozen = join(root, 'frozen.sqlite'),
        archive = join(root, 'assets'),
        file = join(f.worktree, 'exact.txt');
      let changed = false,
        forbidden = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (changed && actual.realpathSync('/proc/self/fd/' + args[0]) === file) forbidden++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      await expect(
        snapshotCodingDatabase(
          join(f.directory, 'runtime.sqlite'),
          frozen,
          async (inventory, desktop) =>
            captureProfileBackupAssets(
              {
                inventory,
                desktop,
                plugins: emptyPluginBackupInventory(),
                profile: f.directory,
                managed: join(f.directory, 'worktrees'),
                databaseBytes: fs.statSync(frozen).size,
              },
              archive,
              async () => {
                if (kind === 'tree') fs.writeFileSync(file, 'late changed source\n');
                if (kind === 'replacement') {
                  fs.writeFileSync(join(root, 'replacement'), 'forbidden new inode');
                  fs.renameSync(join(root, 'replacement'), file);
                }
                if (kind === 'configuration')
                  fs.appendFileSync(join(f.directory, 'coding-projects.json'), ' ');
                if (kind === 'git-index') {
                  const pointer = fs.readFileSync(join(f.worktree, '.git'), 'utf8').slice(8).trim();
                  fs.appendFileSync(join(resolve(f.worktree, pointer), 'index'), 'changed');
                }
                changed = true;
              },
            ),
        ),
      ).rejects.toThrow(/stale_coding/);
      expect(changed).toBe(true);
      if (kind === 'replacement' || kind === 'tree') expect(forbidden).toBe(0);
      expect(fs.existsSync(join(archive, '.incomplete'))).toBe(true);
    } finally {
      f.close();
    }
  },
);
