/**
 * Explicit CLI broadcast commands.
 *
 * The durable batch is runtime-owned: the CLI submits, then reads the same DTO
 * every client sees. It never guesses a child state or claims a remote stop.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { LocalBroadcastBatch } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { required, type OceanArguments } from './arguments.js';

export interface BroadcastCommandResult {
  readonly data: unknown;
  readonly code: number;
}
function progressLines(batch: LocalBroadcastBatch): string[] {
  return batch.recipients
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(
      (child) =>
        `@${child.handle}: ${child.state}${child.resultMessageId ? ' ' + child.resultMessageId : ''}`,
    );
}
/** Poll the durable batch until terminal; the whole wait is bounded by one deadline. */
export async function waitForBroadcastSettlement(
  client: LocalRuntimeClient,
  scope: { workspaceId: string; roomId: string },
  batch: LocalBroadcastBatch,
  output: Writable,
  json: boolean,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<LocalBroadcastBatch> {
  const deadline = Date.now() + timeoutMs;
  let current = batch;
  let last = '';
  for (;;) {
    if (signal.aborted) throw Error('cancelled');
    if (current.state !== 'open') return current;
    if (Date.now() > deadline) throw Error('broadcast_pending');
    const lines = progressLines(current);
    const rendered = lines.join('\n');
    if (!json && rendered !== last) {
      last = rendered;
      output.write(`Рассылка ${current.id} · ревизия ${current.revision}\n${rendered}\n`);
    }
    await delay(250);
    current = await client.broadcastGet({
      ...scope,
      batchId: current.id,
    });
  }
}
export async function runBroadcastCommand(
  client: LocalRuntimeClient,
  args: OceanArguments,
  input: Readable,
  output: Writable,
  error: Writable,
  signal: AbortSignal,
): Promise<BroadcastCommandResult> {
  void input;
  const json = args.json;
  const action = ['show', 'continue', 'abandon'].includes(args.positional[0] ?? '')
    ? args.positional[0]!
    : 'submit';
  const roomId = action === 'submit' ? args.positional[0] : args.positional[1];
  if (roomId === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw Error('invalid_input');
  const workspaceId = 'ws_ocean';
  const scope = { workspaceId, roomId };
  if (action === 'show') {
    const batchId = args.positional[2];
    const requestId = args.flags.get('request-id');
    if (batchId === undefined && requestId === undefined) throw Error('invalid_input');
    const batch = await client.broadcastGet({
      ...scope,
      ...(batchId === undefined ? { requestId: requestId! } : { batchId }),
    });
    return { data: batch, code: batch.state === 'completed' ? 0 : 4 };
  }
  if (action === 'continue' || action === 'abandon') {
    const batchId = args.positional[2];
    if (batchId === undefined) throw Error('invalid_input');
    const expectedRevision = Number(required(args.flags, 'revision'));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw Error('invalid_input');
    const batch =
      action === 'continue'
        ? await client.broadcastContinue({ ...scope, batchId, expectedRevision })
        : await client.broadcastAbandon({ ...scope, batchId, expectedRevision });
    if (!json) output.write(`Рассылка ${batch.id}: ${batch.state} · ревизия ${batch.revision}\n`);
    return { data: batch, code: batch.state === 'completed' ? 0 : 4 };
  }
  const requestId = args.flags.get('request-id') ?? randomUUID();
  const submitted = await client.broadcastSubmit({
    ...scope,
    requestId,
    text: required(args.flags, 'text'),
    ...(args.attachments.length === 0 ? {} : { attachments: args.attachments }),
  });
  if (!json)
    output.write(`Рассылка ${submitted.id} принята: ${submitted.recipients.length} участников\n`);
  const settled = await waitForBroadcastSettlement(client, scope, submitted, error, json, signal);
  return { data: settled, code: settled.state === 'completed' ? 0 : 4 };
}
