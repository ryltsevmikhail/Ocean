import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function environment() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-profile-v2-'));
  roots.push(root);
  for (const name of ['home', 'run', 'userdata']) fs.mkdirSync(join(root, name), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'userdata'));
  return root;
}
// Whole native Git/SQLite recovery lifecycle; measured above the 5s unit-test default.
it('backs up real frozen coding references and restores all evidence after source deletion', async () => {
  const root = environment(),
    f = await codingWorkflowFixture('direct');
  try {
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'exact changeset text\n');
    const changeset = await f.capture('capture');
    fs.writeFileSync(join(f.worktree, 'untracked.bin'), Buffer.from([0, 255, 13, 10]), {
      mode: 0o755,
    });
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        {
          id: 'project',
          root: f.project,
          testPresets: inventory.tasks[0]!.policy.testPresets,
          mounts: [],
        },
      ]),
      { mode: 0o600 },
    );
    const archive = join(root, 'backup'),
      manifest = await backupProfile(f.directory, archive, {
        managedDirectory: join(f.directory, 'worktrees'),
      });
    expect(manifest.format).toBe(2);
    expect(fs.existsSync(join(archive, '.incomplete'))).toBe(false);
    fs.rmSync(f.project, { recursive: true });
    fs.rmSync(join(f.directory, 'worktrees'), { recursive: true });
    fs.rmSync(f.directory, { recursive: true });
    const restored = join(root, 'quarantine');
    expect(restoreProfile(archive, restored)).toEqual(manifest);
    expect(readCodingBackupInventory(join(restored, 'runtime.sqlite')).changesets[0]?.hash).toBe(
      changeset.hash,
    );
    expect(JSON.parse(fs.readFileSync(join(restored, 'restore-guard.json'), 'utf8'))).toMatchObject(
      {
        state: 'ready',
        mode: 'text_only_by_confirmation',
      },
    );
    const slot = inventory.worktrees[0]!.root.split('/').at(-1)!;
    expect(
      fs.readFileSync(
        join(
          restored,
          'assets',
          'worktrees',
          slot,
          'materialized',
          'tree',
          'workspace',
          'untracked.bin',
        ),
      ),
    ).toEqual(Buffer.from([0, 255, 13, 10]));
    expect(
      fs.statSync(
        join(
          restored,
          'assets',
          'worktrees',
          slot,
          'materialized',
          'tree',
          'workspace',
          'untracked.bin',
        ),
      ).mode & 0o777,
    ).toBe(0o755);
  } finally {
    f.close();
  }
}, 30_000);
it('keeps the original copied SQLite identity through the ownership-held finalizer', async () => {
  const root = environment(),
    f = await codingWorkflowFixture('direct');
  try {
    f.runtime.close();
    const { snapshotCodingDatabase } = await import('@runnets/store-sqlite');
    const frozen = join(root, 'frozen.sqlite');
    await expect(
      snapshotCodingDatabase(
        join(f.directory, 'runtime.sqlite'),
        frozen,
        async () => null,
        async () => {
          fs.appendFileSync(frozen, 'late finalizer bytes');
        },
      ),
    ).rejects.toThrow('snapshot_mismatch');
  } finally {
    f.close();
  }
});
it('refuses a destination under a selected source before creating source entries', async () => {
  const root = environment(),
    f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'));
  try {
    const destination = join(f.deps, 'node_modules', 'must-not-create');
    await expect(
      backupProfile(f.directory, destination, { managedDirectory: join(f.directory, 'worktrees') }),
    ).rejects.toThrow();
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  } finally {
    f.close();
  }
});
