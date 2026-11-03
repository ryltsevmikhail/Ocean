import { z } from 'zod';
import { attachment } from './attachments.js';

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
  z.strictObject({ op: z.literal('status') }),
  z.strictObject({ op: z.literal('receipt'), ...room, requestId }),
  z.strictObject({ op: z.literal('bots'), after: id.optional() }),
  z.strictObject({ op: z.literal('rooms'), after: id.optional() }),
  z.strictObject({ op: z.literal('runs'), ...room, after: id.optional() }),
  z.strictObject({
    op: z.literal('observe'),
    ...room,
    runId: id.optional(),
    cursor: z.string().max(512).optional(),
  }),
  z.strictObject({
    op: z.literal('cancel'),
    ...room,
    runId: id,
    requestId,
    expectedVersion: z.int().nonnegative(),
  }),
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
    text: z
      .string()
      .max(16384)
      .refine((s) => !s.startsWith('--') && s !== '-V'),
    attachments: z.array(z.uuid()).max(4).optional(),
  }),
]);
export type Command = z.infer<typeof commands>;
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
  messageId: id,
  roomId: id,
  runId: id,
  version: z.int().nonnegative(),
  performerId: id,
  turnStatus: z.enum([
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
const receipt = z.object({
  workspaceId: z.literal('ws_ocean'),
  roomId: id,
  requestId,
  messageId: id,
  turnId: id.nullable(),
  runId: id.nullable(),
});
const sendStage = z.enum(['preparation', 'refused']);
export type SendStage = z.infer<typeof sendStage>;
export const envelope = z.discriminatedUnion('ok', [
  z.object({ version: z.literal(1), ok: z.literal(true), data: z.unknown() }),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    error: z.object({ code: z.string().regex(/^[a-z_]+$/), sendStage: sendStage.optional() }),
  }),
]);
export const outputs = {
  status: z.object({
    protocol: z.literal(1),
    profileId: z.string().regex(/^[a-f0-9]{64}$/),
    instanceId: z.uuid(),
    state: z.enum(['ready', 'draining', 'stop_incomplete']),
  }),
  rooms: z.array(roomDto).max(pageSize),
  bots: z.array(bot).max(pageSize),
  history: z.array(message).max(pageSize),
  runs: z.array(run).max(pageSize),
  observe: z.object({
    kind: z.enum(['snapshot', 'changed', 'resync', 'timeout']),
    cursor: z.string().max(512),
  }),
  cancel: z.object({ status: z.literal('requested'), version: z.int().positive() }),
  group: z.object({ kind: z.literal('room'), data: roomDto }),
  direct: z.object({ kind: z.literal('room'), data: roomDto }),
  bot: z.object({ kind: z.literal('bot'), data: bot }),
  send: receipt,
  receipt: receipt.nullable(),
};
export type Bot = z.infer<typeof bot>;
export type Room = z.infer<typeof roomDto>;
export type Message = z.infer<typeof message>;
export type Run = z.infer<typeof run>;

export type ProfileReport = z.infer<typeof outputs.status>;
