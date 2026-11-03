/** Frozen pre-7.7 preparation implementation (ce482d5); fixture only, no sender. */
import { dirname, join } from 'node:path';
import { readFile, open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AttachmentStore, attachment, type Attachment } from './legacy-attachment-store.test.js';
interface LegacySend {
  op: 'send';
  room: string;
  requestId: string;
  text: string;
  to: string | null;
  attachments?: string[];
}
const manifest = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  files: z.array(attachment).min(1).max(4),
});
function encodeAttachments(text: string, requestId: string, files: Attachment[]) {
  return (
    text +
    '\n\n[Ocean Desktop attachments v1]\n' +
    JSON.stringify(manifest.parse({ version: 1, requestId, files }))
  );
}
function attachmentText(data: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, 12000), {
      stream: data.length > 12000,
    });
    return text.includes(String.fromCharCode(0)) ? undefined : text.slice(0, 6000);
  } catch {
    return undefined;
  }
}
async function persistReceipt(path: string) {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export class LegacyPreparationHost {
  readonly store: AttachmentStore;
  readonly rooms = new Set<string>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.store = new AttachmentStore(join(root, 'attachments'));
  }
  private check(room: string) {
    if (!this.rooms.has(room)) throw new Error('unknown_room');
  }
  async prepare(c: LegacySend) {
    this.check(c.room);
    if (c.to === null && /^\s*@/.test(c.text)) throw Error('choose_recipient');
    const ids = c.attachments ?? [];
    const receipt = join(this.root, 'attachments', c.room, c.requestId + '.json');
    try {
      const old = JSON.parse(await readFile(receipt, 'utf8')) as Record<string, unknown>;
      if (old['body'] !== c.text || JSON.stringify(old['ids']) !== JSON.stringify(ids))
        throw Error('request_conflict');
      if ('prepared' in old) {
        const text = old['prepared'];
        if (old['to'] !== c.to) throw Error('request_conflict');
        if (
          typeof text !== 'string' ||
          text.length > 16384 ||
          createHash('sha256').update(text).digest('hex') !== old['digest']
        )
          throw Error('attachment_corrupted');
        // A concurrent reader can observe the link before the writer syncs its parent.
        await persistReceipt(receipt);
        return { ...c, text, attachments: undefined };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!ids.length) {
      if (!c.text.trim()) throw new Error('invalid_request');
      return c;
    }
    if (new Set(ids).size !== ids.length) throw new Error('invalid_attachment');
    const files: Attachment[] = [];
    for (const id of ids) files.push((await this.store.read(c.room, id)).info);
    let context = c.text;
    let budget = Math.max(0, 12000 - context.length);
    for (const id of ids) {
      const { info, data } = await this.store.read(c.room, id);
      if (!/\.(txt|md|json|csv|log|ts|js|py|css|html|yaml|yml|xml|toml)$/i.test(info.name))
        continue;
      const snippet = attachmentText(data);
      if (snippet === undefined) continue;
      const part = ('\n\nТекст вложения ' + info.name + ':\n' + snippet).slice(0, budget);
      context += part;
      budget -= part.length;
    }
    context +=
      '\n\n[Вложения сохранены в Desktop. Модели переданы только текстовые выдержки выше и описания файлов. Содержимое изображений и бинарных файлов модели недоступно.]';
    const text = encodeAttachments(context, c.requestId, files);
    if (text.length > 16384) throw new Error('message_too_large');
    const digest = createHash('sha256').update(text).digest('hex');
    const record = { digest, ids, body: c.text, to: c.to, prepared: text };
    const temp = receipt + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temp, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old: unknown = JSON.parse(await readFile(receipt, 'utf8'));
      if (
        !old ||
        typeof old !== 'object' ||
        !('digest' in old) ||
        old.digest !== digest ||
        !('body' in old) ||
        old.body !== c.text ||
        !('ids' in old) ||
        JSON.stringify(old.ids) !== JSON.stringify(ids) ||
        ('to' in old && old.to !== c.to)
      )
        throw new Error('request_conflict');
    } finally {
      await unlink(temp);
    }
    await persistReceipt(receipt);
    return { ...c, text, attachments: undefined };
  }
}
