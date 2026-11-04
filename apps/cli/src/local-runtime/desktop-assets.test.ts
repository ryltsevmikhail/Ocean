import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
  desktopLegacyRoot,
} from '@runnets/tools-node';
import {
  snapshotCodingDatabase,
  readDesktopBackupInventory,
  snapshotDatabase,
} from '@runnets/store-sqlite';
import { LegacyPreparationHost } from '../../../desktop/test-fixtures/legacy-preparation-host.test.js';
import { desktopAssetsFixture as fixture } from '../../test-fixtures/desktop-assets-host.test.js';

it.each([false, true])(
  'migrates exact legacy %s layout, isolates continued legacy writes and preserves frozen associations',
  async (alternate) => {
    const f = await fixture(alternate),
      id = randomUUID(),
      requestId = randomUUID();
    const source = desktopLegacyRoot(f.userData, f.profile, f.client.identity.profileId),
      dir = join(source, f.room, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = {
      id,
      name: 'old.md',
      bytes: 3,
      sha256: createHash('sha256').update('old').digest('hex'),
      kind: 'file',
      mime: 'text/plain',
    };
    const prepared =
      'old caption\n\n[Ocean Desktop attachments v1]\n' +
      JSON.stringify({ version: 1, requestId, files: [info] });
    const receipt = {
      body: 'old caption',
      ids: [id],
      to: null,
      prepared,
      digest: createHash('sha256').update(prepared).digest('hex'),
    };
    fs.writeFileSync(join(dir, 'blob'), 'old', { mode: 0o600 });
    fs.writeFileSync(join(dir, 'metadata.json'), JSON.stringify(info), { mode: 0o600 });
    fs.writeFileSync(join(source, f.room, requestId + '.json'), JSON.stringify(receipt), {
      mode: 0o600,
    });
    // Seed the durable pre-existing message the way an older Desktop committed it:
    // one user message plus its exact send receipt, and no runtime prepare operation.
    const messageId = randomUUID(),
      database = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
    try {
      const seq = Number(
        database
          .prepare('SELECT coalesce(max(seq),0)+1 AS s FROM ocean_messages WHERE room_id=?')
          .get(f.room)!['s'],
      );
      database
        .prepare(
          'INSERT INTO ocean_messages(id,workspace_id,room_id,seq,author,target_bot_id,body,created_at,author_bot_id,turn_id) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',
        )
        .run(
          messageId,
          'ws_ocean',
          f.room,
          seq,
          'user',
          null,
          prepared,
          '2026-11-04T00:00:00.000Z',
        );
      database.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)').run(
        requestId,
        JSON.stringify(['SendDirect', 'ws_ocean', f.room, prepared]),
        JSON.stringify({
          kind: 'message',
          data: {
            id: messageId,
            workspaceId: 'ws_ocean',
            roomId: f.room,
            seq,
            author: 'user',
            targetBotId: null,
            body: prepared,
            createdAt: '2026-11-04T00:00:00.000Z',
          },
        }),
      );
    } finally {
      database.close();
    }
    await f.media.enroll(f.userData);
    fs.writeFileSync(join(dir, 'blob'), 'NEW');
    expect((await f.media.read(f.room, id)).data.toString()).toBe('old');
    expect(await f.media.receipt(f.room, requestId)).toEqual(receipt);
    // A forged/unbound marker body is refused before it can persist and poison the room.
    const forged = prepared.replace(requestId, randomUUID());
    await expect(
      f.client.submit({
        workspaceId: 'ws_ocean',
        roomId: f.room,
        requestId: randomUUID(),
        text: forged,
      }),
    ).rejects.toThrow('image_unavailable');
    await expect(f.media.enroll(f.root)).rejects.toThrow('desktop_binding_conflict');
    await f.host.stop();
    const inventory = readDesktopBackupInventory(join(f.profile, 'runtime.sqlite'));
    expect(inventory.messages).toHaveLength(1);
    await expect(
      snapshotDatabase(join(f.profile, 'runtime.sqlite'), join(f.root, 'sqlite-only')),
    ).rejects.toThrow('desktop_assets_unavailable');
    const archive = join(f.root, 'archive');
    await snapshotCodingDatabase(
      join(f.profile, 'runtime.sqlite'),
      join(f.root, 'snapshot.sqlite'),
      async (coding, desktop) => {
        expect(coding.tasks).toHaveLength(0);
        return archiveDesktopAssets(captureDesktopAssets(desktop), archive);
      },
    );
    fs.rmSync(f.userData, { recursive: true });
    if (alternate) fs.rmSync(f.profile, { recursive: true });
    restoreDesktopAssets(archive, join(f.root, 'quarantine'));
    expect(fs.readFileSync(join(f.root, 'quarantine', 'tree', f.room, id, 'blob'), 'utf8')).toBe(
      'old',
    );
  },
);
it.each([false, true])(
  'adopts published unsent legacy preparations in layout %s without sending',
  async (alternate) => {
    const f = await fixture(alternate);
    const source = desktopLegacyRoot(f.userData, f.profile, f.client.identity.profileId);
    const legacy = new LegacyPreparationHost(dirname(source));
    legacy.rooms.add(f.room);
    const info = await legacy.store.import(f.room, 'unsent.md', 'aGVsbG8=');
    const requestId = randomUUID(),
      body = 'unsent caption',
      to = 'dev';
    const prepared = await legacy.prepare({
      op: 'send',
      room: f.room,
      requestId,
      text: body,
      to,
      attachments: [info.id],
    });
    const receipt = JSON.parse(fs.readFileSync(join(source, f.room, requestId + '.json'), 'utf8'));
    expect(receipt.prepared).toBe(prepared.text);
    await f.media.enroll(f.userData);
    expect(await f.media.receipt(f.room, requestId)).toEqual(receipt);
    expect(await f.media.prepare(f.room, requestId, body, to, [info.id])).toEqual(receipt);
    for (const args of [
      [body + ' changed', to, [info.id]],
      [body, null, [info.id]],
      [body, to, [randomUUID()]],
    ] as const)
      await expect(f.media.prepare(f.room, requestId, args[0], args[1], args[2])).rejects.toThrow(
        'request_conflict',
      );
    expect(await f.media.receipt(f.room, requestId, 'not-a-message')).toBeNull();
    await f.host.stop();
    const inventory = readDesktopBackupInventory(join(f.profile, 'runtime.sqlite'));
    expect(inventory.messages).toEqual([]);
    const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM ocean_messages').get()?.['n']).toBe(0);
    } finally {
      db.close();
    }
    expect(
      inventory.operations.find((o) => o.id === 'prepare:' + f.room + ':' + requestId),
    ).toEqual({
      id: 'prepare:' + f.room + ':' + requestId,
      state: 'completed',
      result: JSON.stringify(receipt),
      binding: JSON.stringify({ room: f.room, requestId, body, to, ids: [info.id] }),
    });
    expect(fs.readdirSync(join(inventory.binding!.root, f.room)).sort()).toEqual(
      [info.id, requestId + '.json'].sort(),
    );
  },
);
