import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  connectLocalRuntime,
  DesktopAttachmentClient,
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
} from '@runnets/tools-node';
import { snapshotCodingDatabase } from '@runnets/store-sqlite';
import { startLocalRuntime } from './host.js';
import {
  desktopAssetsFixture as fixture,
  onCleanup,
} from '../../test-fixtures/desktop-assets-host.test.js';

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
  onCleanup(() => host.stop());
  const client = await connectLocalRuntime({ profile: f.profile });
  onCleanup(() => client.close());
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
  onCleanup(() => host.stop());
  const client = await connectLocalRuntime({ profile: relocated });
  onCleanup(() => client.close());
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
  onCleanup(() => client.close());
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
