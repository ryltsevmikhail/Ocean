import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectLocalRuntime, DesktopAttachmentClient } from '@runnets/tools-node';
import { isDesktopCommand, isDesktopReply } from '@runnets/contracts';
import {
  desktopAssetsFixture as fixture,
  onCleanup,
} from '../../test-fixtures/desktop-assets-host.test.js';
import { startLocalRuntime } from './host.js';
function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const raw = db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
      'value'
    ];
    return {
      binding: raw ? (JSON.parse(String(raw)) as { root: string }) : null,
      operations: db
        .prepare('SELECT * FROM ocean_desktop_operations ORDER BY id')
        .all()
        .map((row) => ({ ...row, id: String(row['id']), state: String(row['state']) })),
      uploads: db.prepare('SELECT * FROM ocean_desktop_uploads ORDER BY id').all(),
      adopted: db.prepare('SELECT * FROM ocean_desktop_adopted ORDER BY message_id').all(),
    };
  } finally {
    db.close();
  }
}
it('keeps attach request and reply closed and path-free', () => {
  expect(isDesktopCommand({ op: 'attach' })).toBe(true);
  expect(isDesktopCommand({ op: 'attach', userData: '/other' })).toBe(false);
  expect(isDesktopReply({ op: 'attach', ok: true })).toBe(true);
  expect(isDesktopReply({ op: 'attach', ok: true, root: '/other' })).toBe(false);
});
it('two authenticated clients with different fresh userData share anchored originals with no second adoption', async () => {
  const f = await fixture(true);
  await expect(f.client.desktopAssets({ op: 'attach' })).rejects.toThrow('desktop_not_enrolled');
  await f.media.connect(f.userData);
  const bytes = Buffer.from([0, 255, 17, 1]);
  const asset = await f.media.import(f.room, 'original.bin', bytes.toString('base64'));
  const before = snapshot(join(f.profile, 'runtime.sqlite'));
  const otherRoot = join(f.root, 'second-userData');
  fs.mkdirSync(otherRoot, { mode: 0o700 });
  const other = await connectLocalRuntime({ profile: f.profile });
  onCleanup(() => other.close());
  const media = new DesktopAttachmentClient(other);
  await media.connect(otherRoot);
  expect((await media.read(f.room, asset.id)).data).toEqual(bytes);
  expect(fs.readdirSync(otherRoot)).toEqual([]);
  expect(snapshot(join(f.profile, 'runtime.sqlite'))).toEqual(before);
  await expect(media.enroll(otherRoot)).rejects.toThrow('desktop_binding_conflict');
  expect((await media.read(f.room, asset.id)).data).toEqual(bytes);
});
it('concurrent first clients enroll once and attach to the winner without adopting the loser', async () => {
  const f = await fixture(true),
    otherRoot = join(f.root, 'second-userData');
  fs.mkdirSync(otherRoot, { mode: 0o700 });
  const other = await connectLocalRuntime({ profile: f.profile });
  onCleanup(() => other.close());
  let readers = 0,
    release!: () => void;
  const both = new Promise<void>((r) => {
    release = r;
  });
  const client = (peer: typeof other) =>
    new DesktopAttachmentClient({
      desktopAssets: async (command) => {
        try {
          return await peer.desktopAssets(command);
        } catch (error) {
          if (
            command.op === 'attach' &&
            error instanceof Error &&
            error.message === 'desktop_not_enrolled'
          ) {
            if (++readers === 2) release();
            await both;
          }
          throw error;
        }
      },
    });
  await Promise.all([client(f.client).connect(f.userData), client(other).connect(otherRoot)]);
  const inventory = snapshot(join(f.profile, 'runtime.sqlite'));
  expect(inventory.operations.filter((op) => op.id === 'enrollment')).toHaveLength(1);
  expect(inventory.operations.find((op) => op.id === 'enrollment')?.state).toBe('completed');
  expect(fs.readdirSync(f.profile).filter((n) => n.startsWith('desktop-'))).toHaveLength(1);
  expect(await other.desktopAssets({ op: 'attach' })).toEqual({ op: 'attach', ok: true });
});
it('attach never turns interrupted enrollment into permission to retry', async () => {
  const f = await fixture(true);
  await f.host.stop();
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
  db.prepare("INSERT INTO ocean_desktop_operations VALUES('enrollment',?,'started',NULL)").run(
    f.userData,
  );
  db.close();
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  onCleanup(() => host.stop());
  const peer = await connectLocalRuntime({ profile: f.profile });
  onCleanup(() => peer.close());
  await expect(new DesktopAttachmentClient(peer).connect(f.userData)).rejects.toThrow(
    'desktop_outcome_unknown',
  );
  expect(fs.readdirSync(f.profile).filter((n) => n.startsWith('desktop-'))).toEqual([]);
});
it('a replaced anchored tree refuses attach before any legacy enrollment', async () => {
  const f = await fixture(true);
  await f.media.connect(f.userData);
  const inventory = snapshot(join(f.profile, 'runtime.sqlite'));
  const root = inventory.binding!.root;
  fs.renameSync(root, root + '-original');
  fs.mkdirSync(root, { mode: 0o700 });
  await expect(f.media.connect(f.userData)).rejects.toThrow('desktop_binding_mismatch');
  expect(snapshot(join(f.profile, 'runtime.sqlite'))).toEqual(inventory);
});
