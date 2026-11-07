import assert from 'node:assert/strict';
import { join } from 'node:path';
import { restoredConnectionContract } from './model-mixed-restored-contract.ts';
import { DatabaseSync } from 'node:sqlite';
import { rig } from './model-process-rig.ts';
import { descriptors, mixedSetup } from './model-mixed-setup.ts';
import type { MixedSnapshot } from './model-mixed-ports.ts';
// eslint-disable-next-line no-restricted-imports -- Source types only; backup executes dist.
import type * as Snapshots from '../src/ocean/snapshots.js';
const { backupProfile, restoreProfile }: typeof Snapshots = await import(
  String('../dist/ocean/snapshots.js')
);
export async function mixedRestore() {
  const f = await rig('mixed');
  try {
    const owner = await f.launch(),
      a = await f.peer();
    const m = await mixedSetup(a.client);
    assert.equal((await a.client.stop()).outcome, 'complete');
    await owner.kill();
    await a.kill();
    const archive = join(f.root, 'archive'),
      restored = join(f.root, 'restored');
    const raw = (profile: string) => {
      const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
      try {
        return JSON.stringify({
          receipts: db.prepare('SELECT * FROM command_receipts ORDER BY command_id').all(),
          events: db.prepare('SELECT * FROM events ORDER BY aggregate_id,sequence').all(),
          foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
        });
      } finally {
        db.close();
      }
    };
    const original = raw(f.profile);
    const manifest = await backupProfile(f.profile, archive, {
      managedDirectory: join(f.root, 'worktrees'),
    });
    assert.equal(manifest.format, 2);
    assert.deepEqual(restoreProfile(archive, restored), manifest);
    assert.equal(
      raw(restored) === original,
      true,
      'backup changed raw receipts/events/foreign keys',
    );
    await assert.rejects(f.launch(false, restored), /restore_restricted/);
    const next = await f.launch(true, restored),
      b = await f.peer('sdk', restored);
    const baseline = await next.snapshot();
    const connections = await b.client.listModelConnections();
    for (const d of descriptors) {
      const row = connections.items.find((r) => r.connectionId === d.connectionId)!;
      assert.equal(row.configuration?.configuredAfterRestore, false);
      assert.equal(row.restriction, 'restore_restricted');
    }
    for (const [index, roomId] of m.rooms.entries())
      await assert.rejects(
        b.client.submit({
          workspaceId: 'ws_ocean',
          roomId,
          requestId: 'inert-' + index,
          text: 'inert',
        }),
        /restore_restricted/,
      );
    assert.deepEqual(await next.snapshot(), baseline);
    assert.deepEqual(await next.call<MixedSnapshot>('mixedSnapshot'), {
      origins: {},
      requests: [],
    });
    await assert.rejects(
      b.client.setModelConnection({
        ...descriptors[0]!,
        expectedRevision: 2,
        requestId: 'maintenance-denied-set',
      }),
      /restore_restricted/,
    );
    assert.deepEqual(await next.snapshot(), baseline);
    assert.deepEqual(await next.call<MixedSnapshot>('mixedSnapshot'), {
      origins: {},
      requests: [],
    });
    assert.equal((await b.client.stop()).outcome, 'complete');
    await next.kill();
    await b.kill();
    const contract = await restoredConnectionContract(restored, m.bots, m.rooms[0]!);
    return {
      restoredConnections: 3,
      maintenanceEffects: 0,
      maintenanceMutationsRefused: true,
      ordinaryStartupRefused: true,
      rawReceiptsAndEventsPreserved: true,
      contract,
    };
  } finally {
    await f.close();
  }
}
