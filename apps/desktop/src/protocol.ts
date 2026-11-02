import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/);
const handle = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
// CLI v1 reserves values starting with "--" and treats "-V" as a version probe.
const value = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !s.startsWith('--') && s !== '-V');
const requestId = z.uuid();
const room = { room: id };
export const commands = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('init') }),
  z.strictObject({ op: z.literal('doctor') }),
  z.strictObject({ op: z.literal('bots') }),
  z.strictObject({ op: z.literal('rooms') }),
  z.strictObject({ op: z.literal('runs'), ...room }),
  z.strictObject({ op: z.literal('history'), ...room, after: z.int().nonnegative() }),
  z.strictObject({
    op: z.literal('bot'),
    requestId,
    handle,
    name: value(256),
    role: value(8192),
    model: value(256),
  }),
  z.strictObject({ op: z.literal('direct'), requestId, bot: id }),
  z.strictObject({
    op: z.literal('group'),
    requestId,
    title: value(256),
    bots: z.array(id).min(2).max(32),
  }),
  z.strictObject({
    op: z.literal('send'),
    requestId,
    ...room,
    to: handle.nullable(),
    text: value(16384),
  }),
]);
export type Command = z.infer<typeof commands>;
export const pageSize = 16;
export const bot = z.object({
  id,
  handle,
  name: z.string(),
  role: z.string(),
  provider: z.string(),
  model: z.string(),
});
export const roomDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), id, botId: id }),
  z.object({ kind: z.literal('group'), id, title: z.string(), botIds: z.array(id) }),
]);
export const message = z.object({
  id,
  roomId: id,
  seq: z.int().positive(),
  author: z.enum(['user', 'bot']),
  authorBotId: id.optional(),
  targetBotId: id.nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export const run = z.object({
  roomId: id.nullable(),
  turnStatus: z.string().nullable(),
  taskStatus: z.string(),
  taskRunId: id,
  mode: z.string().nullable(),
});
export const envelope = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), data: z.unknown() }),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    error: z.object({ code: z.string().regex(/^[a-z_]+$/) }),
  }),
]);
export const outputs = {
  init: z.object({ kind: z.literal('workspace') }),
  doctor: z.object({ providerKeyPresent: z.boolean(), restored: z.boolean() }),
  rooms: z.array(roomDto),
  bots: z.array(bot),
  history: z.array(message),
  runs: z.array(run),
  group: z.object({ kind: z.literal('room'), data: roomDto }),
  direct: z.object({ kind: z.literal('room'), data: roomDto }),
  bot: z.object({ kind: z.literal('bot'), data: bot }),
  send: z.object({
    status: z.enum([
      'recorded',
      'completed',
      'cancelled',
      'uncertain',
      'failed',
      'prepared',
      'dispatching',
      'accepted',
    ]),
  }),
};
export type Bot = z.infer<typeof bot>;
export type Room = z.infer<typeof roomDto>;
export type Message = z.infer<typeof message>;
export type Run = z.infer<typeof run>;
