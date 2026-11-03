import { z } from 'zod';
export const attachmentId = z.uuid();
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
export const attachmentCommands = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('attachment-import'),
    room: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/),
    name: z.string().min(1).max(180),
    data: z.string().max(14 * 1024 * 1024),
  }),
  z.strictObject({
    op: z.literal('attachment-preview'),
    room: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/),
    id: attachmentId,
  }),
  z.strictObject({
    op: z.literal('attachment-save'),
    room: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/),
    id: attachmentId,
  }),
]);
export const attachmentPreview = z.object({
  image: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
  text: z.string().max(6000).optional(),
});
export type AttachmentPreview = z.infer<typeof attachmentPreview>;
const manifest = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  files: z.array(attachment).min(1).max(4),
});
const marker = '\n\n[Ocean Desktop attachments v1]\n';
export function encodeAttachments(text: string, requestId: string, files: Attachment[]) {
  return text + marker + JSON.stringify(manifest.parse({ version: 1, requestId, files }));
}
export function decodeAttachments(body: string) {
  const index = body.lastIndexOf(marker);
  if (index < 0) return null;
  try {
    return {
      body: body.slice(0, index),
      ...manifest.parse(JSON.parse(body.slice(index + marker.length))),
    };
  } catch {
    return null;
  }
}
