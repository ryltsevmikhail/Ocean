/**
 * Public client for the durable broadcast API.
 *
 * Responses are validated against the versioned contracts; the client never
 * infers child state or a batch decision from transport timing.
 */

import {
  isLocalBroadcastBatch,
  isLocalBroadcastGet,
  isLocalBroadcastList,
  isLocalBroadcastSubmit,
  isLocalBroadcastVote,
  type LocalBroadcastBatch,
  type LocalBroadcastGet,
  type LocalBroadcastList,
  type LocalBroadcastSubmit,
  type LocalBroadcastVote,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';

type Send = (method: string, params: unknown, timeout?: number) => Promise<unknown>;

export interface LocalBroadcastClient {
  broadcastSubmit(input: LocalBroadcastSubmit): Promise<LocalBroadcastBatch>;
  broadcastGet(input: LocalBroadcastGet): Promise<LocalBroadcastBatch>;
  broadcastList(input: LocalBroadcastList): Promise<readonly LocalBroadcastBatch[]>;
  broadcastContinue(input: LocalBroadcastVote): Promise<LocalBroadcastBatch>;
  broadcastAbandon(input: LocalBroadcastVote): Promise<LocalBroadcastBatch>;
}
function batch(value: unknown): LocalBroadcastBatch {
  if (!isLocalBroadcastBatch(value)) throw Error('invalid_frame');
  return value;
}
export function localBroadcastClient(send: Send): LocalBroadcastClient {
  return {
    async broadcastSubmit(input) {
      return batch(await send('broadcasts.submit', validatedParams(input, isLocalBroadcastSubmit)));
    },
    async broadcastGet(input) {
      return batch(await send('broadcasts.get', validatedParams(input, isLocalBroadcastGet)));
    },
    async broadcastList(input) {
      const value = await send('broadcasts.list', validatedParams(input, isLocalBroadcastList));
      if (!Array.isArray(value) || value.length > 50) throw Error('invalid_frame');
      return value.map(batch);
    },
    async broadcastContinue(input) {
      return batch(await send('broadcasts.continue', validatedParams(input, isLocalBroadcastVote)));
    },
    async broadcastAbandon(input) {
      return batch(await send('broadcasts.abandon', validatedParams(input, isLocalBroadcastVote)));
    },
  };
}
