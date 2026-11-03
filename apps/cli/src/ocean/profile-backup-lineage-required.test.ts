import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { prepareProfileBackupAssets, type ProfileBackupSource } from '@runnets/tools-node';

it('refuses an origin-bearing preparation that lacks the frozen lineage reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'lineage-required-'));
  try {
    const manifest = {
      format: 2,
      sha256: 'a'.repeat(64),
      bytes: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      cli: 'test',
      node: 'test',
      summary: {
        schema: 13,
        rooms: 0,
        messages: 0,
        positions: [],
        pendingEffects: 0,
        unfinishedRuns: 0,
        heldRooms: 0,
      },
      assets: {
        catalog: 'a'.repeat(64),
        codingInventory: 'a'.repeat(64),
        desktopInventory: 'a'.repeat(64),
        worktrees: 'a'.repeat(64),
        recovery: 'a'.repeat(64),
        dependencies: 'a'.repeat(64),
        desktop: null,
      },
    };
    const source = {
      inventory: {
        format: 1,
        hash: 'a'.repeat(64),
        tasks: [],
        worktrees: [],
        changesets: [],
        applications: [],
      },
      desktop: {},
      profile: join(root, 'profile'),
      managed: join(root, 'managed'),
      databaseBytes: 1,
      // A caller that supplies the durable restoration state but omits readSnapshot must
      // not be able to archive the restored profile's frozen old-profile assets as live.
      restoration: {
        origin: {
          version: 1,
          snapshotId: 'a'.repeat(64),
          profileRoot: join(root, 'profile'),
          profileId: 'a'.repeat(64),
          sourceOwners: ['old-owner'],
          manifest,
        },
        origins: [],
        records: [],
        observations: [],
        activeRequestId: null,
        retired: [],
      },
    } as unknown as ProfileBackupSource;
    const destination = join(root, 'assets');
    expect(() => prepareProfileBackupAssets(source, destination)).toThrow(
      'restoration_lineage_required',
    );
    expect(existsSync(destination)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
