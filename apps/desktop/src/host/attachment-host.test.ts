import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
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
it('binds bytes to a room and immutable request before the owner admits the message', async () => {
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
  await unlink(join(root, 'attachments', 'room_one', info.id, 'blob'));
  expect(await host.prepare(command)).toEqual(input);
  await expect(host.prepare({ ...command, to: 'review' })).rejects.toThrow('request_conflict');
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
it('isolates the same room and request under two configured profile roots', async () => {
  const { profileAssets } = await import('./profile-assets.js');
  const { createHash } = await import('node:crypto');
  const data = await mkdtemp(join(tmpdir(), 'ocean-roots-'));
  roots.push(data);
  const locate = (p: string) =>
    profileAssets(data, p, createHash('sha256').update(p).digest('hex'));
  const original = join(data, 'conversation', 'profile');
  expect(locate(original)).toBe(join(data, 'conversation'));
  const host = (p: string) => new AttachmentHost(locate(p), {} as BrowserWindow);
  const a = host(original),
    b = host(join(data, 'other'));
  for (const h of [a, b]) h.rooms.add('room');
  const f = (await a.handle({
    op: 'attachment-import',
    room: 'room',
    name: 'notes.md',
    data: 'YQ==',
  })) as Attachment;
  const input = await a.prepare({
    op: 'send',
    room: 'room',
    requestId: crypto.randomUUID(),
    text: 'cap',
    to: null,
    attachments: [f.id],
  });
  const m = {
    id: 'm',
    seq: 1,
    author: 'user' as const,
    roomId: 'room',
    targetBotId: null,
    body: input.text,
    createdAt: new Date().toISOString(),
  };
  expect(await host(original).history([m])).toMatchObject([{ body: 'cap', attachments: [f] }]);
  expect(await b.history([m])).toEqual([m]);
  await expect(b.handle({ op: 'attachment-preview', room: 'room', id: f.id })).rejects.toThrow();
});
