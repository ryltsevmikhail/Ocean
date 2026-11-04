import { z } from 'zod';
import { attachment } from './attachments.js';

const id = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/);
const handle = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const pageSize = 16;
export const bot = z.object({
  id,
  handle,
  name: z.string().max(256),
  role: z.string().max(8192),
  provider: z.string().max(128),
  model: z.string().max(256),
});
export const roomDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), id, botId: id }),
  z.object({
    kind: z.literal('group'),
    id,
    title: z.string().max(256),
    botIds: z.array(id).min(2).max(32),
  }),
]);
export const message = z.object({
  id,
  roomId: id,
  seq: z.int().positive(),
  author: z.enum(['user', 'bot']),
  authorBotId: id.optional(),
  targetBotId: id.nullable(),
  body: z.string().max(1048576),
  createdAt: z.iso.datetime({ offset: true }),
  attachments: z.array(attachment).max(4).optional(),
});
export const run = z.object({
  turnId: id,
  messageId: id,
  roomId: id,
  runId: id,
  version: z.int().nonnegative(),
  performerId: id,
  turnStatus: z.enum([
    'queued',
    'accepted',
    'dispatching',
    'prepared',
    'completed',
    'failed',
    'uncertain',
    'cancelled',
  ]),
  taskStatus: z.string().max(64),
  pendingDecisionIds: z.array(z.string().max(128)).max(200),
});

export type Bot = z.infer<typeof bot>;
export type Room = z.infer<typeof roomDto>;
export type Message = z.infer<typeof message>;
export type Run = z.infer<typeof run>;
