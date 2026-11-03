import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), readSync: vi.fn(actual.readSync) };
});
import { verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { isRestored } from './restored.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-publication-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  return { root, f: await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false) };
}
it('retains an incomplete root when copied SQLite changes during the last archive consumers', async () => {
  const { root, f } = await fixture(),
    actual = await vi.importActual<typeof fs>('node:fs'),
    archive = join(root, 'backup');
  let changed = false;
  try {
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (
        !changed &&
        actual.existsSync(join(archive, 'snapshot.json')) &&
        actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(join(archive, 'assets') + '/')
      ) {
        changed = true;
        actual.appendFileSync(join(archive, 'runtime.sqlite'), 'late consumer mutation');
      }
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    await expect(
      backupProfile(f.directory, archive, { managedDirectory: join(f.directory, 'worktrees') }),
    ).rejects.toThrow();
    expect(changed).toBe(true);
    expect(fs.existsSync(join(archive, '.incomplete'))).toBe(true);
    expect(() => verifyProfileBackupEnvelope(archive)).toThrow();
  } finally {
    f.close();
  }
});
it('keeps quarantine incomplete if the original archive changes during the final consumer', async () => {
  const { root, f } = await fixture(),
    actual = await vi.importActual<typeof fs>('node:fs'),
    archive = join(root, 'backup'),
    quarantine = join(root, 'quarantine');
  try {
    await backupProfile(f.directory, archive, { managedDirectory: join(f.directory, 'worktrees') });
    let changed = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actual.renameSync(from, to);
      if (String(to) === join(quarantine, 'restore-guard.json')) {
        changed = true;
        actual.appendFileSync(join(archive, 'runtime.sqlite'), 'late archive mutation');
      }
    });
    expect(() => restoreProfile(archive, quarantine)).toThrow('invalid_backup');
    expect(changed).toBe(true);
    expect(fs.existsSync(join(quarantine, '.incomplete'))).toBe(true);
    expect(() => isRestored(quarantine)).toThrow('recovery_required');
  } finally {
    f.close();
  }
});
