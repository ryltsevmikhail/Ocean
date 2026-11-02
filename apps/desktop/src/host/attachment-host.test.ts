import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { AttachmentHost } from './attachment-host.js';
import type { Attachment } from '../attachments.js';
import { decodeAttachments } from '../attachments.js';
vi.mock('electron', () => ({ dialog: {}, nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
it('binds bytes to a room and immutable request before the CLI writes the message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-asset-host-'));
  roots.push(root);
  const host = new AttachmentHost(root, {} as BrowserWindow);
  host.rooms.add('room_one');
  const info = (await host.handle({
    op: 'attachment-import',
    room: 'room_one',
    name: 'notes.md',
    data: Buffer.from('Text for the selected bot').toString('base64'),
  })) as Attachment;
  const command = {
    op: 'send' as const,
    room: 'room_one',
    requestId: '12345678-1234-4123-8123-123456789abc',
    text: 'caption',
    to: 'dev',
    attachments: [info.id],
  };
  const input = await host.prepare(command);
  expect(input.text).toContain('Text for the selected bot');
  expect(decodeAttachments(input.text)?.files).toEqual([info]);
  expect(await host.prepare(command)).toEqual(input);
  await expect(host.prepare({ ...command, text: 'different' })).rejects.toThrow('request_conflict');
  const message = {
    id: 'msg_1',
    seq: 1,
    roomId: 'room_one',
    author: 'user' as const,
    targetBotId: 'bot_dev',
    body: input.text,
    createdAt: new Date().toISOString(),
  };
  const reopened = new AttachmentHost(root, {} as BrowserWindow);
  expect(await reopened.history([message])).toEqual([
    { ...message, body: 'caption', attachments: [info] },
  ]);
  expect(
    (await reopened.history([{ ...message, body: 'forged' + input.text }]))[0]?.attachments,
  ).toBeUndefined();
  expect(
    (await reopened.history([{ ...message, roomId: 'room_two' }]))[0]?.attachments,
  ).toBeUndefined();
  host.rooms.add('room_two');
  await expect(
    host.handle({ op: 'attachment-preview', room: 'room_two', id: info.id }),
  ).rejects.toThrow();
  await expect(
    host.handle({ op: 'attachment-preview', room: 'unknown', id: info.id }),
  ).rejects.toThrow('unknown_room');
});
