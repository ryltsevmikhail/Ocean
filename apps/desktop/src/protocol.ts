import { z } from 'zod';
import { isLocalProviderSetRequest, isLocalProviderRevisionRequest } from '@runnets/contracts';
const providerRequestId = z
  .string()
  .max(128)
  .refine((value) => value.trim() !== '');
import { serviceCommands, serviceOutputs } from './service-protocol.js';
import { modelCommands, modelOutputs } from './model-protocol.js';
import { pluginCommands, pluginOutputs } from './plugin-protocol.js';
import { bot, message, pageSize, roomDto, run } from './protocol-room.js';
export * from './protocol-room.js';
export type { Bot, Room, Message, Run } from './protocol-room.js';

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
const baseCommands = [
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
  z.strictObject({ op: z.literal('provider') }),
  z.strictObject({ op: z.literal('provider-check') }),
  z
    .strictObject({
      op: z.literal('provider-set'),
      requestId: providerRequestId,
      key: z.string().min(1).max(512).optional(),
      model: z.string().min(1).max(256),
    })
    .refine(({ op: _op, ...input }) => isLocalProviderSetRequest(input)),
  z
    .strictObject({
      op: z.literal('provider-disconnect'),
      requestId: providerRequestId,
      expectedRevision: z.int().nonnegative(),
    })
    .refine(({ op: _op, ...input }) => isLocalProviderRevisionRequest(input)),
  z
    .strictObject({
      op: z.literal('provider-remove-key'),
      requestId: providerRequestId,
      expectedRevision: z.int().nonnegative(),
    })
    .refine(({ op: _op, ...input }) => isLocalProviderRevisionRequest(input)),
  z.strictObject({
    op: z.literal('broadcast'),
    requestId,
    ...room,
    text: z
      .string()
      .max(16384)
      .refine((value) => !value.startsWith('--') && value !== '-V'),
    attachments: z.array(z.uuid()).max(4).optional(),
  }),
  z.strictObject({ op: z.literal('broadcast-list'), ...room }),
  z.strictObject({
    op: z.literal('broadcast-continue'),
    ...room,
    batchId: id,
    expectedRevision: z.int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('broadcast-abandon'),
    ...room,
    batchId: id,
    expectedRevision: z.int().nonnegative(),
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
] as const;
export const commands = z.discriminatedUnion('op', [
  ...baseCommands,
  ...pluginCommands,
  ...modelCommands,
  ...serviceCommands,
]);
export type Command = z.infer<typeof commands>;
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
export const providerSource = z.enum(['saved', 'external', 'injected', 'none']);
export const providerState = z.enum([
  'connected',
  'disconnected',
  'unverified',
  'absent',
  'restored',
  'invalid_model',
]);
export const providerCheckOutcome = z.enum([
  'ok',
  'auth',
  'network',
  'timeout',
  'cancelled',
  'server',
  'unavailable',
]);
const providerModel = z.string().min(1).max(256);
export const providerCheckMetadata = z.object({
  outcome: providerCheckOutcome,
  httpStatus: z.int().min(100).max(599).nullable(),
  durationMs: z.int().nonnegative(),
  models: z.array(providerModel).max(200),
  modelSupported: z.boolean(),
  source: providerSource,
  revision: z.int().nonnegative(),
  checkedAt: z.iso.datetime({ offset: true }),
});
export const providerStatus = z
  .object({
    provider: z.string().min(1).max(64),
    source: providerSource,
    state: providerState,
    model: providerModel.nullable(),
    models: z.array(providerModel).max(200),
    modelCapabilities: z
      .array(z.object({ model: providerModel, imageInput: z.boolean() }))
      .max(200),
    revision: z.int().nonnegative(),
    savedKey: z.boolean(),
    writable: z.boolean(),
    code: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .nullable(),
    lastCheck: providerCheckMetadata.nullable(),
  })
  .strict();
export const broadcastChildState = z.enum([
  'queued',
  'running',
  'answered',
  'refused',
  'uncertain',
  'cancelled',
  'not_started',
]);
export const broadcastChild = z.object({
  botId: id,
  handle: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  turnId: id,
  runId: id,
  position: z.int().nonnegative(),
  state: broadcastChildState,
  resultMessageId: id.nullable(),
  refusalCode: z.string().max(64).nullable().optional(),
});
export const broadcastBatch = z
  .object({
    version: z.literal(1),
    id,
    workspaceId: z.literal('ws_ocean'),
    roomId: id,
    requestId,
    messageId: id,
    boundarySeq: z.int().positive(),
    recipients: z.array(broadcastChild).min(2).max(32),
    state: z.enum(['open', 'paused', 'completed', 'abandoned']),
    revision: z.int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
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
  broadcast: broadcastBatch,
  'broadcast-list': z.array(broadcastBatch).max(50),
  'broadcast-continue': broadcastBatch,
  'broadcast-abandon': broadcastBatch,
  provider: providerStatus,
  'provider-set': providerStatus,
  'provider-disconnect': providerStatus,
  'provider-remove-key': providerStatus,
  'provider-check': z.object({
    status: providerStatus,
    check: providerCheckMetadata.extend({ persisted: z.boolean() }),
  }),
  ...pluginOutputs,
  ...modelOutputs,
  ...serviceOutputs,
};
export type ProfileReport = z.infer<typeof outputs.status>;
export type ProviderStatus = z.infer<typeof providerStatus>;
export type BroadcastBatch = z.infer<typeof broadcastBatch>;
export type BroadcastChild = z.infer<typeof broadcastChild>;
export type ProviderCheck = z.infer<(typeof outputs)['provider-check']>['check'];
