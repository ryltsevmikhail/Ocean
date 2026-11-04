import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { DesktopAttachmentClient, connectLocalRuntime } from '@runnets/tools-node';
import { AttachmentHost } from './attachment-host.js';
import type { Attachment } from '../attachments.js';
import { decodeAttachments } from '../attachments.js';
import { openOceanProfile } from '../../../cli/src/ocean/profile.js';
import { startLocalRuntime } from '../../../cli/src/local-runtime/host.js';
import { rooms } from '../../../cli/test-fixtures/local-runtime-admission.test.js';
vi.mock('electron', () => ({ dialog: {}, nativeImage: {} }));
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});
it('uses the actual authenticated runtime for native host import, preparation and history', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-asset-host-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'userData'),
    profile = join(root, 'profile'),
    home = join(root, 'home');
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const run = join(root, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const scope = rooms(runtime.conversations);
  runtime.close();
  const owner = await startLocalRuntime({ profile, provider: null });
  cleanup.push(() => owner.stop());
  const client = await connectLocalRuntime({ profile });
  cleanup.push(() => client.close());
  const adapter = new DesktopAttachmentClient(client);
  await adapter.enroll(userData);
  const host = new AttachmentHost(adapter, {} as BrowserWindow);
  host.rooms.add(scope.groupId);
  const info = (await host.handle({
    op: 'attachment-import',
    room: scope.groupId,
    name: 'notes.md',
    data: Buffer.from('Text for the selected bot').toString('base64'),
  })) as Attachment;
  const command = {
    op: 'send' as const,
    room: scope.groupId,
    requestId: randomUUID(),
    text: 'caption',
    to: null,
    attachments: [info.id],
  };
  const input = await host.prepare(command);
  expect(input.text).toContain('Text for the selected bot');
  expect(decodeAttachments(input.text)?.files).toEqual([info]);
  expect(await host.prepare(command)).toEqual(input);
  await expect(host.prepare({ ...command, to: 'review' })).rejects.toThrow('request_conflict');
  await expect(host.prepare({ ...command, text: 'different' })).rejects.toThrow('request_conflict');
  const accepted = await client.submit({
    workspaceId: 'ws_ocean',
    roomId: scope.groupId,
    requestId: command.requestId,
    text: input.text,
  });
  const message = {
    id: accepted.messageId,
    seq: 1,
    roomId: scope.groupId,
    author: 'user' as const,
    targetBotId: null,
    body: input.text,
    createdAt: new Date().toISOString(),
  };
  const reopened = new AttachmentHost(new DesktopAttachmentClient(client), {} as BrowserWindow);
  expect(await reopened.history([message])).toEqual([
    { ...message, body: 'caption', attachments: [info] },
  ]);
  expect(
    (await reopened.history([{ ...message, body: 'forged' + input.text }]))[0]?.attachments,
  ).toBeUndefined();
  expect(
    (await reopened.history([{ ...message, roomId: scope.roomId }]))[0]?.attachments,
  ).toBeUndefined();
  // A copied/forged prepared body can no longer be admitted for a different
  // request id: the runtime refuses it before any message exists (RC2 I3).
  await expect(
    client.submit({
      workspaceId: 'ws_ocean',
      roomId: scope.groupId,
      requestId: randomUUID(),
      text: input.text,
    }),
  ).rejects.toThrow('image_unavailable');
  // The history decoder still refuses to render an unbound marker row.
  expect(
    (await reopened.history([{ ...message, id: 'foreign-message' }]))[0]?.attachments,
  ).toBeUndefined();
  await expect(
    host.handle({ op: 'attachment-preview', room: 'unknown', id: info.id }),
  ).rejects.toThrow('unknown_room');
});
