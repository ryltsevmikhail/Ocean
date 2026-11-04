import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { DesktopAttachmentClient } from '@runnets/tools-node';
import { attachmentCommands, decodeAttachments } from '../attachments.js';
import { attachmentText } from './attachment-text.js';
import type { Command, Message } from '../protocol.js';
/** Native rendering/export only. Runtime owns every attachment and preparation publication. */
export class AttachmentHost {
  readonly rooms: Set<string>;
  private readonly client: DesktopAttachmentClient;
  private readonly win: BrowserWindow;
  constructor(client: DesktopAttachmentClient, win: BrowserWindow, rooms = new Set<string>()) {
    this.client = client;
    this.win = win;
    this.rooms = rooms;
  }
  private check(room: string) {
    if (!this.rooms.has(room)) throw Error('unknown_room');
  }
  async handle(raw: unknown) {
    const c = attachmentCommands.parse(raw);
    this.check(c.room);
    if (c.op === 'attachment-import') {
      const info = await this.client.import(c.room, c.name, c.data);
      if (info.kind === 'image') {
        const { data } = await this.client.read(c.room, info.id);
        const image = nativeImage.createFromBuffer(data),
          size = image.getSize();
        // Align the native preview guard with the trusted runtime's documented
        // 8192-px side limit; the runtime still re-validates the persisted header.
        if (image.isEmpty() || size.width > 8192 || size.height > 8192)
          throw Error('image_too_large');
      }
      return info;
    }
    const { info, data } = await this.client.read(c.room, c.id);
    if (c.op === 'attachment-save') {
      const chosen = await dialog.showSaveDialog(this.win, {
        defaultPath: info.name,
        buttonLabel: 'Сохранить файл',
      });
      if (chosen.canceled || !chosen.filePath) return { saved: false };
      await writeFile(chosen.filePath, data);
      return { saved: true };
    }
    if (info.kind === 'image') {
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) throw Error('invalid_image');
      const { width, height } = image.getSize(),
        scale = Math.min(1, 768 / width, 768 / height);
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
    if (c.to === null && /^\s*@/.test(c.text)) throw Error('choose_recipient');
    const ids = c.attachments ?? [];
    if (!ids.length) {
      if (!c.text.trim()) throw Error('invalid_request');
      return c;
    }
    const receipt = await this.client.prepare(c.room, c.requestId, c.text, c.to, ids);
    return { ...c, text: receipt.prepared, attachments: undefined };
  }
  /** Broadcast uses the same runtime-owned preparation; the wire payload stays target-less. */
  async prepareBroadcast(c: Extract<Command, { op: 'broadcast' }>) {
    this.check(c.room);
    const ids = c.attachments ?? [];
    if (!ids.length) {
      if (!c.text.trim()) throw Error('invalid_request');
      return c;
    }
    const receipt = await this.client.prepare(c.room, c.requestId, c.text, null, ids);
    return { ...c, text: receipt.prepared };
  }
  async history(messages: Message[]) {
    return Promise.all(
      messages.map(async (m) => {
        if (m.author !== 'user') return m;
        const parsed = decodeAttachments(m.body);
        if (!parsed) return m;
        try {
          const receipt = await this.client.receipt(m.roomId, parsed.requestId, m.id);
          if (
            !receipt ||
            receipt.digest !== createHash('sha256').update(m.body).digest('hex') ||
            receipt.prepared !== m.body
          )
            return m;
          return { ...m, body: receipt.body, attachments: parsed.files };
        } catch {
          return m;
        }
      }),
    );
  }
}
