import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentText } from './attachment-text.js';
import { AttachmentStore } from '../../test-fixtures/legacy-attachment-store.test.js';
import { decodeAttachments, encodeAttachments } from '../attachments.js';
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'ocean-attachments-'));
  roots.push(root);
  return { root, storage: new AttachmentStore(root) };
}
it('persists exact binary bytes and metadata through reopening and isolates rooms', async () => {
  const { root, storage } = await store();
  const bytes = Buffer.from([0, 1, 255, 4, 0]);
  const info = await storage.import('room_one', 'report.bin', bytes.toString('base64'));
  expect((await new AttachmentStore(root).read('room_one', info.id)).data).toEqual(bytes);
  await expect(storage.read('room_two', info.id)).rejects.toThrow();
  expect((await stat(join(root, 'room_one', info.id, 'blob'))).mode & 0o777).toBe(0o600);
  const out = join(root, 'saved.bin');
  await storage.copy('room_one', info.id, out);
  expect(await readFile(out)).toEqual(bytes);
});
it('rejects tampered content before download and prevents path traversal', async () => {
  const { root, storage } = await store();
  const info = await storage.import(
    'room_one',
    '../report.txt',
    Buffer.from('safe').toString('base64'),
  );
  expect(info.name).toBe('.._report.txt');
  await expect(storage.read('../elsewhere', info.id)).rejects.toThrow('invalid_request');
  await expect(storage.read('room_one', '../../etc/passwd')).rejects.toThrow('invalid_request');
  await writeFile(join(root, 'room_one', info.id, 'blob'), 'bad');
  await expect(storage.read('room_one', info.id)).rejects.toThrow('attachment_corrupted');
});
it('rejects invalid input and round-trips the versioned runtime reference', async () => {
  const { storage } = await store();
  await expect(
    storage.import('room_one', 'test.png', Buffer.from('text').toString('base64')),
  ).rejects.toThrow('invalid_image');
  await expect(storage.import('room_one', 'file', '%%%')).rejects.toThrow('invalid_attachment');
  await expect(
    storage.import('room_one', 'file', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')),
  ).rejects.toThrow('attachment_too_large');
  const info = await storage.import(
    'room_one',
    'test.txt',
    Buffer.from('hello').toString('base64'),
  );
  const requestId = '12345678-1234-4123-8123-123456789abc';
  expect(decodeAttachments(encodeAttachments('caption', requestId, [info]))).toEqual({
    body: 'caption',
    version: 1,
    requestId,
    files: [info],
  });
  expect(decodeAttachments('plain old history')).toBeNull();
  expect(decodeAttachments('text\n\n[Ocean Desktop attachments v1]\n{}')).toBeNull();
});

it('previews a long Unicode file without treating a split code point as binary', () => {
  expect(attachmentText(Buffer.from('a' + 'ж'.repeat(6001)))).toBe('a' + 'ж'.repeat(5999));
  expect(attachmentText(Buffer.from([0, 1, 255]))).toBeUndefined();
});
