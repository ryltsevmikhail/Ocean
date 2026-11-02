import { z } from 'zod';
import {
  attachment,
  attachmentCommands,
  attachmentPreview,
  type Attachment,
} from '../attachments.js';
import { envelope } from '../protocol.js';

async function request<T>(command: unknown, schema: z.ZodType<T>): Promise<T> {
  const input = attachmentCommands.parse(command);
  const reply = envelope.parse(await window.ocean.request(input));
  if (!reply.ok) throw new Error(reply.error.code);
  return schema.parse(reply.data);
}
export async function importFile(room: string, file: File): Promise<Attachment> {
  if (file.size > 10 * 1024 * 1024) throw new Error('attachment_too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return request(
    { op: 'attachment-import', room, name: file.name, data: btoa(binary) },
    attachment,
  );
}
export function previewFile(room: string, id: string) {
  return request({ op: 'attachment-preview', room, id }, attachmentPreview);
}
export function saveFile(room: string, id: string) {
  return request({ op: 'attachment-save', room, id }, z.object({ saved: z.boolean() }));
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' Б';
  return bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + ' КБ'
    : (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}
