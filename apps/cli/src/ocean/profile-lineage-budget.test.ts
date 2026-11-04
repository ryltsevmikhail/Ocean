import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureProfileBackupAssets,
  prepareProfileBackupAssets,
  ProfileBackupOutput,
  verifyProfileBackupEnvelope,
  type ProfileBackupLimits,
} from '@runnets/tools-node';
import * as stores from '@runnets/store-sqlite';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const bytes = (root: string): number => {
  let total = 0;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) total += fs.statSync(join(entry.parentPath, entry.name)).size;
  return total;
};
const fileHash = (path: string) => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
type Dimension = keyof ProfileBackupLimits;
interface Attempt {
  readonly ok: boolean;
  readonly error: string;
}
it('shares one real backup budget across the lineage chain without deduplicating occurrences', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lineage-budget-')),
    home = join(root, 'home');
  roots.push(root);
  fs.mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const f = await codingWorkflowFixture('direct');
  try {
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'chain budget marker\n');
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const inventory = stores.readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
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
    const archive1 = join(root, 'archive-1');
    await backupProfile(f.directory, archive1, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.directory, { recursive: true });
    const first = join(root, 'profile-1');
    restoreProfile(archive1, first);
    fs.rmSync(archive1, { recursive: true });
    // The second generation is a genuine lineage backup (parent + frozen database).
    const archive2 = join(root, 'archive-2');
    await backupProfile(first, archive2);
    const secondSize = bytes(archive2);
    const second = join(root, 'profile-2');
    restoreProfile(archive2, second);
    fs.rmSync(archive2, { recursive: true });
    const manifestHash = () =>
      [join(first, 'restore-origin/runtime.sqlite'), join(second, 'restore-origin/runtime.sqlite')]
        .map(fileHash)
        .join(':');
    const frozen = manifestHash();
    let index = 0;
    const attempt = async (
      profile: string,
      limits: Partial<ProfileBackupLimits>,
      keep = false,
    ): Promise<Attempt> => {
      const to = join(root, 'attempt-' + index++);
      let output: ProfileBackupOutput | undefined,
        capture: Awaited<ReturnType<typeof captureProfileBackupAssets>> | undefined,
        prepared: ReturnType<typeof prepareProfileBackupAssets> | undefined;
      try {
        await stores.snapshotCodingDatabase(
          join(profile, 'runtime.sqlite'),
          (value, desktop, databaseBytes, restoration, plugins) => {
            prepared = prepareProfileBackupAssets(
              {
                inventory: value,
                desktop,
                plugins,
                profile,
                managed: join(profile, 'worktrees'),
                databaseBytes,
                restoration,
                readSnapshot: stores.readProfileRestoreSnapshot,
              },
              join(to, 'assets'),
              limits,
            );
            // The root destination marker exists only after the durable preparation intent.
            output = new ProfileBackupOutput(to);
            return join(to, 'runtime.sqlite');
          },
          async () => (capture = await captureProfileBackupAssets(prepared!, join(to, 'assets'))),
          () => {
            // Publication stays inside the live original-source witness lifetime, as in the host.
            capture!.publish();
            output!.publish();
            return Promise.resolve();
          },
        );
        return { ok: true, error: '' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        capture?.close();
        prepared?.close();
        output?.close();
        if (!keep) fs.rmSync(to, { recursive: true, force: true });
      }
    };
    const minimum = async (profile: string, dimension: Dimension, upper: number) => {
      let low = 0,
        high = upper;
      while (low < high) {
        const middle = Math.floor((low + high) / 2),
          result = await attempt(profile, { [dimension]: middle });
        if (result.ok) high = middle;
        else if (result.error === 'profile_backup_limit') low = middle + 1;
        else throw Error(dimension + ':' + result.error);
      }
      const check = await attempt(profile, { [dimension]: low });
      if (!check.ok) throw Error(dimension + ':no-success:' + check.error);
      return low;
    };
    const bounds: Record<Dimension, number> = {
      stored: secondSize * 4,
      logical: secondSize * 4,
      metadata: secondSize * 4,
      entries: 10000,
    };
    const thresholds = {} as Record<Dimension, number>;
    for (const dimension of ['stored', 'logical', 'metadata', 'entries'] as const) {
      thresholds[dimension] = await minimum(first, dimension, bounds[dimension]);
    }
    // Every ceiling for the chain generation is strictly larger: parent occurrences are
    // charged again through the shared session (no cross-envelope deduplication).
    for (const dimension of ['stored', 'logical', 'metadata', 'entries'] as const) {
      const chained = await attempt(second, { [dimension]: thresholds[dimension] });
      expect(chained, dimension).toEqual({ ok: false, error: 'profile_backup_limit' });
      expect(fs.existsSync(join(root, 'attempt-' + (index - 1)))).toBe(false);
    }
    expect(
      thresholds.stored,
      'stored, logical, metadata and entries must each accumulate across the chain',
    ).toBeGreaterThan(secondSize);
    // A metadata refusal after the destination exists retains the incomplete output; the
    // independent verifier then refuses it while the frozen source bytes are unchanged.
    const incomplete = await attempt(first, { metadata: thresholds.metadata - 1 }, true);
    expect(incomplete).toEqual({ ok: false, error: 'profile_backup_limit' });
    const destination = join(root, 'attempt-' + (index - 1));
    expect(fs.existsSync(join(destination, '.incomplete'))).toBe(true);
    expect(fs.existsSync(join(destination, 'assets', '.incomplete'))).toBe(true);
    expect(() => verifyProfileBackupEnvelope(destination)).toThrow();
    expect(fs.existsSync(join(destination, 'snapshot.json'))).toBe(false);
    expect(manifestHash()).toBe(frozen);
    expect(fs.existsSync(join(first, 'restore-origin', 'snapshot.json'))).toBe(true);
    // The same metadata ceiling is far below the chained generation's real requirement.
    const chainedMetadata = await attempt(second, { metadata: thresholds.metadata });
    expect(chainedMetadata).toEqual({ ok: false, error: 'profile_backup_limit' });
  } finally {
    f.close();
  }
}, 600000);
