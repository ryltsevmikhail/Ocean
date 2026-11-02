import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { readFile, open, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  attachmentCommands,
  decodeAttachments,
  encodeAttachments,
  type Attachment,
} from '../attachments.js';
import { AttachmentStore } from './attachment-store.js';
import { attachmentText } from './attachment-text.js';
import type { Command, Message } from '../protocol.js';

export class AttachmentHost {
  private readonly store: AttachmentStore;
  readonly rooms = new Set<string>();
  private readonly root: string;
  private readonly win: BrowserWindow;
  constructor(root: string, win: BrowserWindow) {
    this.root = root;
    this.win = win;
    this.store = new AttachmentStore(join(root, 'attachments'));
  }
  private check(room: string) {
    if (!this.rooms.has(room)) throw new Error('unknown_room');
  }
  async handle(raw: unknown) {
    const c = attachmentCommands.parse(raw);
    this.check(c.room);
    if (c.op === 'attachment-import') {
      const info = await this.store.import(c.room, c.name, c.data);
      if (info.kind === 'image') {
        const { data } = await this.store.read(c.room, info.id);
        const image = nativeImage.createFromBuffer(data);
        if (
          image.isEmpty() ||
          image.getSize().width * image.getSize().height > 24_000_000 ||
          image.getSize().width > 16384 ||
          image.getSize().height > 16384
        )
          throw new Error('invalid_image');
      }
      return info;
    }
    const { info, data } = await this.store.read(c.room, c.id);
    if (c.op === 'attachment-save') {
      const chosen = await dialog.showSaveDialog(this.win, {
        defaultPath: info.name,
        buttonLabel: 'Сохранить файл',
      });
      if (chosen.canceled || !chosen.filePath) return { saved: false };
      await this.store.copy(c.room, c.id, chosen.filePath);
      return { saved: true };
    }
    if (info.kind === 'image') {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) throw new Error('invalid_image');
      const { width, height } = image.getSize();
      const scale = Math.min(1, 768 / width, 768 / height);
      return {
        image: image
          .resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          })
          .toDataURL(),
      };
    }
    if (!info.mime.startsWith('text/')) return {};
    const text = attachmentText(data);
    return text === undefined ? {} : { text };
  }
  async prepare(c: Extract<Command, { op: 'send' }>) {
    this.check(c.room);
    const ids = c.attachments ?? [];
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
    const receipt = join(this.root, 'attachments', c.room, c.requestId + '.json');
    const digest = createHash('sha256').update(text).digest('hex');
    const record = { digest, ids, body: c.text };
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
      if (JSON.stringify(old) !== JSON.stringify(record)) throw new Error('request_conflict');
    } finally {
      await unlink(temp);
    }
    const directory = await open(join(this.root, 'attachments', c.room), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { ...c, text, attachments: undefined };
  }
  async history(messages: Message[]) {
    return Promise.all(
      messages.map(async (m) => {
        if (m.author !== 'user') return m;
        const parsed = decodeAttachments(m.body);
        if (!parsed) return m;
        try {
          const receipt: unknown = JSON.parse(
            await readFile(
              join(this.root, 'attachments', m.roomId, parsed.requestId + '.json'),
              'utf8',
            ),
          );
          if (
            !receipt ||
            typeof receipt !== 'object' ||
            !('digest' in receipt) ||
            receipt.digest !== createHash('sha256').update(m.body).digest('hex')
          )
            return m;
          return {
            ...m,
            body:
              'body' in receipt && typeof receipt.body === 'string' ? receipt.body : parsed.body,
            attachments: parsed.files,
          };
        } catch {
          return m;
        }
      }),
    );
  }
}
