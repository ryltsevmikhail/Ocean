import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDesktopPrivate } from './desktop-private-read.js';
import { withDesktopRoom } from './desktop-private-write.js';
import { desktopBindingMatches, withDesktopRoot } from './desktop-root.js';
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
    !desktopBindingMatches(binding) ||
    !desktopRoom(room) ||
    (id !== undefined && !desktopUuid(id))
  )
    throw Error('desktop_binding_mismatch');
  const path = join(binding.root, room, ...(id ? [id] : []));
  if (fs.existsSync(path) && fs.realpathSync(path) !== path)
    throw Error('desktop_binding_mismatch');
  return path;
}
/** Private attachment metadata only; no blob read. */
export function desktopMetadata(
  binding: DesktopBinding,
  room: string,
  id: string,
): DesktopAttachment {
  return withDesktopRoot(binding, (root) => {
    const info: unknown = JSON.parse(
      readDesktopPrivate(root, room, id, 'metadata.json', 131072).toString('utf8'),
    );
    if (!validDesktopAttachment(info) || info.id !== id) throw Error('desktop_asset_corrupted');
    return info;
  });
}
export function desktopRead(binding: DesktopBinding, room: string, id: string) {
  return withDesktopRoot(binding, (root) => {
    const info = desktopMetadata(binding, room, id);
    root.verify();
    const data = readDesktopPrivate(root, room, id, 'blob', 10485760);
    if (data.length !== info.bytes || desktopHash(data) !== info.sha256)
      throw Error('desktop_asset_corrupted');
    return { info, data };
  });
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
  return withDesktopRoom(binding, room, (parent, verify) => {
    const temp = fs.mkdtempSync(join(parent, '.upload-'));
    desktopWrite(join(temp, 'blob'), data);
    desktopWrite(join(temp, 'metadata.json'), JSON.stringify(info));
    desktopSync(temp);
    verify();
    fs.renameSync(temp, join(parent, info.id));
    return info;
  });
}
export function readDesktopPreparation(
  binding: DesktopBinding,
  room: string,
  requestId: string,
): DesktopPreparation {
  if (!desktopUuid(requestId)) throw Error('invalid_params');
  return withDesktopRoot(
    binding,
    (root) =>
      JSON.parse(
        readDesktopPrivate(root, room, null, requestId + '.json', 131072).toString('utf8'),
      ) as DesktopPreparation,
  );
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
  return withDesktopRoot(binding, () => {
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
    return withDesktopRoom(binding, room, (directory, verify) => {
      const receipt = join(directory, requestId + '.json'),
        temp = receipt + '.' + randomUUID() + '.tmp';
      desktopWrite(temp, JSON.stringify(record));
      verify();
      fs.linkSync(temp, receipt);
      fs.unlinkSync(temp);
      return record;
    });
  });
}
