import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { privateAssetDirectory, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  validDesktopAttachment,
  desktopRoom,
  desktopUuid,
  encodeDesktopAttachments,
  type DesktopAttachment,
  type DesktopBinding,
  type DesktopPreparation,
} from '@runnets/domain';
import { desktopRootIdentity } from './desktop-assets.js';
export const desktopHash = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
export function desktopSync(path: string): void {
  const fd = fs.openSync(path, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function desktopWrite(path: string, data: Buffer | string): void {
  const fd = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function desktopDirectory(binding: DesktopBinding, room: string, id?: string): string {
  if (
    desktopRootIdentity(binding.root) !== binding.identity ||
    !desktopRoom(room) ||
    (id !== undefined && !desktopUuid(id))
  )
    throw Error('desktop_binding_mismatch');
  const path = join(binding.root, room, ...(id ? [id] : []));
  if (fs.existsSync(path) && fs.realpathSync(path) !== path)
    throw Error('desktop_binding_mismatch');
  return path;
}
function readPrivate(path: string, mount: string, limit: number): Buffer {
  const parent = privateAssetDirectory(dirname(path));
  try {
    if (codingAssetMount(parent) !== mount) throw Error('desktop_binding_mismatch');
    const name = path.slice(dirname(path).length + 1),
      at = join(assetFdPath(parent), name);
    const fd = fs.openSync(
      at,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const s = fs.fstatSync(fd, { bigint: true }),
        state = codingAssetIdentity(s);
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 0o777n) !== 0o600n ||
        s.size > BigInt(limit) ||
        codingAssetMount(fd) !== mount
      )
        throw Error('desktop_asset_corrupted');
      const data = Buffer.alloc(Number(s.size));
      let offset = 0;
      while (offset < data.length) {
        const n = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (!n) throw Error('desktop_asset_corrupted');
        offset += n;
      }
      if (
        codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
        codingAssetIdentity(fs.lstatSync(at, { bigint: true })) !== state
      )
        throw Error('desktop_asset_corrupted');
      checkAssetPath(parent, dirname(path));
      checkAssetPath(fd, path);
      return data;
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.closeSync(parent);
  }
}
export function desktopRead(binding: DesktopBinding, room: string, id: string) {
  const directory = desktopDirectory(binding, room, id),
    info: unknown = JSON.parse(
      readPrivate(
        join(directory, 'metadata.json'),
        binding.identity.split(':').at(-1)!,
        131072,
      ).toString('utf8'),
    );
  if (!validDesktopAttachment(info) || info.id !== id) throw Error('desktop_asset_corrupted');
  const data = readPrivate(join(directory, 'blob'), binding.identity.split(':').at(-1)!, 10485760);
  if (data.length !== info.bytes || desktopHash(data) !== info.sha256)
    throw Error('desktop_asset_corrupted');
  return { info, data };
}
function imageMime(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}
const textName = /\.(txt|md|json|csv|log|ts|js|py|css|html|yaml|yml|xml|toml)$/i;
export function importDesktopFile(
  binding: DesktopBinding,
  room: string,
  name: string,
  encoded: string,
): DesktopAttachment {
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded || data.length > 10485760)
    throw Error('invalid_attachment');
  const clean = Array.from(name, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\' ? '_' : c,
  )
    .join('')
    .slice(0, 180);
  if (!clean.trim()) throw Error('invalid_attachment');
  const image = imageMime(data);
  if (/\.(png|jpe?g|gif|webp)$/i.test(clean) && !image) throw Error('invalid_image');
  const mime =
    image ??
    (data.toString('ascii', 0, 5) === '%PDF-'
      ? 'application/pdf'
      : data[0] === 80 && data[1] === 75 && data[2] === 3 && data[3] === 4
        ? 'application/zip'
        : textName.test(clean)
          ? 'text/plain'
          : 'application/octet-stream');
  const info = {
    id: randomUUID(),
    name: clean,
    bytes: data.length,
    sha256: desktopHash(data),
    kind: image ? ('image' as const) : ('file' as const),
    mime,
  };
  const parent = desktopDirectory(binding, room);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(join(parent, '.upload-'));
  desktopWrite(join(temp, 'blob'), data);
  desktopWrite(join(temp, 'metadata.json'), JSON.stringify(info));
  desktopSync(temp);
  fs.renameSync(temp, join(parent, info.id));
  desktopSync(parent);
  desktopSync(binding.root);
  return info;
}
export function readDesktopPreparation(
  binding: DesktopBinding,
  room: string,
  requestId: string,
): DesktopPreparation {
  if (!desktopUuid(requestId)) throw Error('invalid_params');
  return JSON.parse(
    readPrivate(
      join(desktopDirectory(binding, room), requestId + '.json'),
      binding.identity.split(':').at(-1)!,
      131072,
    ).toString('utf8'),
  ) as DesktopPreparation;
}
function snippet(data: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, 12000), {
      stream: data.length > 12000,
    });
    return text.includes(String.fromCharCode(0)) ? undefined : text.slice(0, 6000);
  } catch {
    return undefined;
  }
}
export function prepareDesktopFiles(
  binding: DesktopBinding,
  room: string,
  requestId: string,
  body: string,
  to: string | null,
  ids: readonly string[],
): DesktopPreparation {
  if (
    !desktopUuid(requestId) ||
    ids.length < 1 ||
    ids.length > 4 ||
    new Set(ids).size !== ids.length
  )
    throw Error('invalid_attachment');
  if (to === null && /^\s*@/.test(body)) throw Error('choose_recipient');
  const files = ids.map((id) => desktopRead(binding, room, id));
  let context = body,
    budget = Math.max(0, 12000 - body.length);
  for (const { info, data } of files) {
    const text = textName.test(info.name) ? snippet(data) : undefined;
    if (text === undefined) continue;
    const part = ('\n\nТекст вложения ' + info.name + ':\n' + text).slice(0, budget);
    context += part;
    budget -= part.length;
  }
  // Images now reach vision models as real content through runtime authority; the
  // disclaimer must stop claiming they are unavailable. Legacy text-only messages
  // keep their existing wording.
  const images = files.some(({ info }) => info.kind === 'image');
  context += images
    ? '\n\n[Вложения сохранены в Desktop. Текстовые выдержки переданы выше. Изображения передаются модели как изображения, если выбранная модель поддерживает изображения; содержимое остальных бинарных файлов модели недоступно.]'
    : '\n\n[Вложения сохранены в Desktop. Модели переданы только текстовые выдержки выше и описания файлов. Содержимое изображений и бинарных файлов модели недоступно.]';
  const prepared = encodeDesktopAttachments(
    context,
    requestId,
    files.map((f) => f.info),
  );
  if (prepared.length > 16384) throw Error('message_too_large');
  const record = { digest: desktopHash(prepared), ids, body, to, prepared };
  const receipt = join(desktopDirectory(binding, room), requestId + '.json'),
    temp = receipt + '.' + randomUUID() + '.tmp';
  desktopWrite(temp, JSON.stringify(record));
  fs.linkSync(temp, receipt);
  fs.unlinkSync(temp);
  desktopSync(desktopDirectory(binding, room));
  return record;
}
