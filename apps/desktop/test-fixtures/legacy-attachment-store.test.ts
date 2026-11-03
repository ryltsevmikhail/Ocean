/** Frozen legacy writer fixture only; never imported by the Desktop host. */
import { mkdir, mkdtemp, open, rename, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
const attachmentId = z.uuid();
export const attachment = z.object({
  id: attachmentId,
  name: z.string().min(1).max(180),
  bytes: z
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['image', 'file']),
  mime: z.string().max(100),
});
export type Attachment = z.infer<typeof attachment>;

const roomId = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/;
function directory(root: string, room: string, id?: string) {
  if (!roomId.test(room) || (id && !attachmentId.safeParse(id).success))
    throw new Error('invalid_request');
  return id ? join(root, room, id) : join(root, room);
}
function hash(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}
function imageMime(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}
function mimeType(data: Buffer, name: string) {
  const image = imageMime(data);
  if (image) return image;
  if (data.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4) return 'application/zip';
  if (/\.(txt|md|json|csv|log|ts|js|py|css|html|yaml|yml|xml|toml)$/i.test(name))
    return 'text/plain';
  return 'application/octet-stream';
}
async function write(path: string, data: Buffer | string) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
}
export class AttachmentStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async import(room: string, name: string, encoded: string): Promise<Attachment> {
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded))
      throw new Error('invalid_attachment');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) throw new Error('invalid_attachment');
    if (data.length > 10 * 1024 * 1024) throw new Error('attachment_too_large');
    const clean = Array.from(name, (c) =>
      c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\' ? '_' : c,
    )
      .join('')
      .slice(0, 180);
    if (!clean.trim()) throw new Error('invalid_attachment');
    const mime = imageMime(data);
    if (/\.(png|jpe?g|gif|webp)$/i.test(clean) && !mime) throw new Error('invalid_image');
    const info: Attachment = {
      id: randomUUID(),
      name: clean,
      bytes: data.length,
      sha256: hash(data),
      kind: mime ? 'image' : 'file',
      mime: mimeType(data, clean),
    };
    const parent = directory(this.root, room);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(parent, '.upload-'));
    await write(join(temp, 'blob'), data);
    await write(join(temp, 'metadata.json'), JSON.stringify(info));
    const staged = await open(temp, 'r');
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(temp, directory(this.root, room, info.id));
    for (const path of [parent, this.root, join(this.root, '..')]) {
      const dir = await open(path, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    return info;
  }
  async read(room: string, id: string) {
    const dir = directory(this.root, room, id);
    const info = attachment.parse(JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')));
    if (info.id !== id) throw new Error('invalid_attachment');
    const data = await readFile(join(dir, 'blob'));
    if (data.length !== info.bytes || hash(data) !== info.sha256)
      throw new Error('attachment_corrupted');
    return { info, data };
  }
  async copy(room: string, id: string, to: string) {
    await this.read(room, id);
    await copyFile(join(directory(this.root, room, id), 'blob'), to);
  }
}
