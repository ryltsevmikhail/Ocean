import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  connectLocalRuntime,
  DesktopAttachmentClient,
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
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { LegacyPreparationHost } from '../../../desktop/test-fixtures/legacy-preparation-host.test.js';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});
async function fixture(alternate = false) {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-desktop-service-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'userData'),
    home = join(root, 'home');
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const run = join(root, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const profile = alternate ? join(root, 'alternate') : join(userData, 'conversation', 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const r = rooms(runtime.conversations);
  runtime.close();
  const host = await startLocalRuntime({ profile, provider: null });
  cleanups.push(() => host.stop());
  const client = await connectLocalRuntime({ profile });
  cleanups.push(() => client.close());
  const media = new DesktopAttachmentClient(client);
  return { root, profile, userData, room: r.groupId, client, host, media };
}
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
    await f.client.submit({ workspaceId: 'ws_ocean', roomId: f.room, requestId, text: prepared });
    await f.media.enroll(f.userData);
    fs.writeFileSync(join(dir, 'blob'), 'NEW');
    expect((await f.media.read(f.room, id)).data.toString()).toBe('old');
    expect(await f.media.receipt(f.room, requestId)).toEqual(receipt);
    const forged = prepared.replace(requestId, randomUUID());
    await f.client.submit({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      requestId: randomUUID(),
      text: forged,
    });
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
it('keeps imports bounded, exact retries idempotent, and interrupted preparation unknown', async () => {
  const f = await fixture();
  await f.media.enroll(f.userData);
  const uploadId = randomUUID(),
    bytes = Buffer.alloc(700000, 97);
  const info = await f.media.import(f.room, 'large.txt', bytes.toString('base64'), uploadId);
  expect(await f.media.import(f.room, 'large.txt', bytes.toString('base64'), uploadId)).toEqual(
    info,
  );
  expect((await f.media.read(f.room, info.id)).data.equals(bytes)).toBe(true);
  const request = randomUUID(),
    prepared = await f.media.prepare(f.room, request, 'caption', null, [info.id]);
  expect(await f.media.prepare(f.room, request, 'caption', null, [info.id])).toEqual(prepared);
  await expect(f.media.prepare(f.room, request, 'changed', null, [info.id])).rejects.toThrow(
    'request_conflict',
  );
  await expect(
    f.media.prepare(f.room, randomUUID(), 'caption', null, Array(5).fill(info.id)),
  ).rejects.toThrow('invalid_params');
  await expect(
    f.media.import(f.room, 'huge', Buffer.alloc(10485761).toString('base64')),
  ).rejects.toThrow('invalid_attachment');
  await f.host.stop();
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite')),
    interrupted = randomUUID();
  const binding = JSON.stringify({
    room: f.room,
    requestId: interrupted,
    body: 'unknown',
    to: null,
    ids: [info.id],
  });
  db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'started',NULL)").run(
    'prepare:' + f.room + ':' + interrupted,
    binding,
  );
  db.close();
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanups.push(() => host.stop());
  const client = await connectLocalRuntime({ profile: f.profile });
  cleanups.push(() => client.close());
  const media = new DesktopAttachmentClient(client);
  await expect(media.prepare(f.room, interrupted, 'unknown', null, [info.id])).rejects.toThrow(
    'desktop_outcome_unknown',
  );
  expect(await media.receipt(f.room, interrupted)).toBeNull();
});
it('refuses a relocated profile binding before reading its old canonical assets', async () => {
  const f = await fixture();
  await f.media.enroll(f.userData);
  await f.host.stop();
  const relocated = join(f.root, 'moved');
  fs.cpSync(f.profile, relocated, { recursive: true });
  fs.chmodSync(relocated, 0o700);
  const host = await startLocalRuntime({ profile: relocated, provider: null });
  cleanups.push(() => host.stop());
  const client = await connectLocalRuntime({ profile: relocated });
  cleanups.push(() => client.close());
  await expect(new DesktopAttachmentClient(client).enroll(f.userData)).rejects.toThrow(
    'desktop_binding_mismatch',
  );
});
it('does not admit a send that changes the recipient of a durable preparation', async () => {
  const f = await fixture();
  await f.media.enroll(f.userData);
  const info = await f.media.import(f.room, 'notes.md', 'aGVsbG8='),
    requestId = randomUUID();
  const receipt = await f.media.prepare(f.room, requestId, 'caption', 'dev', [info.id]);
  await expect(
    f.client.submit({ workspaceId: 'ws_ocean', roomId: f.room, requestId, text: receipt.prepared }),
  ).rejects.toThrow('request_conflict');
});
it('retains disconnected incomplete upload bytes as inert source-independent evidence', async () => {
  const f = await fixture();
  await f.media.enroll(f.userData);
  const id = randomUUID();
  await f.client.desktopAssets({
    op: 'begin',
    id,
    room: f.room,
    name: 'partial.md',
    bytes: 5,
    sha256: createHash('sha256').update('hello').digest('hex'),
  });
  await f.client.desktopAssets({ op: 'chunk', id, offset: 0, data: 'aGVs' });
  f.client.close();
  const client = await connectLocalRuntime({ profile: f.profile });
  cleanups.push(() => client.close());
  await expect(client.desktopAssets({ op: 'commit', id })).rejects.toThrow('upload_incomplete');
  await f.host.stop();
  const archive = join(f.root, 'partial-archive');
  await snapshotCodingDatabase(
    join(f.profile, 'runtime.sqlite'),
    join(f.root, 'partial.sqlite'),
    async (_coding, desktop) => {
      expect(desktop.uploads).toEqual([
        {
          id,
          room: f.room,
          name: 'partial.md',
          bytes: 5,
          sha256: createHash('sha256').update('hello').digest('hex'),
          data: 'aGVs',
        },
      ]);
      return archiveDesktopAssets(captureDesktopAssets(desktop), archive);
    },
  );
  fs.rmSync(f.profile, { recursive: true });
  const output = join(f.root, 'partial-restore');
  restoreDesktopAssets(archive, output);
  const inert = JSON.parse(fs.readFileSync(join(output, 'desktop-evidence.json'), 'utf8'));
  expect(Buffer.from(inert.uploads[0].data, 'base64').toString()).toBe('hel');
  expect(fs.readdirSync(join(output, 'tree'))).toEqual([]);
});

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
