/**
 * Public client for the runtime-owned provider connection API.
 *
 * Every reply is validated against the versioned contract; only metadata ever
 * crosses the socket. The key input is validated locally before it is framed.
 */

import {
  isLocalProviderCheckResponse,
  isLocalProviderRevisionRequest,
  isLocalProviderSetRequest,
  isLocalProviderStatus,
  type LocalProviderCheckResponse,
  type LocalProviderRevisionRequest,
  type LocalProviderSetRequest,
  type LocalProviderStatus,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';

type Send = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
/** One bounded check may take the full ten-second owner deadline plus framing slack. */
const CHECK_TIMEOUT_MS = 12_000;

export interface LocalProviderClient {
  providerStatus(): Promise<LocalProviderStatus>;
  providerCheck(): Promise<LocalProviderCheckResponse>;
  providerSet(input: LocalProviderSetRequest): Promise<LocalProviderStatus>;
  providerDisconnect(input: LocalProviderRevisionRequest): Promise<LocalProviderStatus>;
  providerRemoveSavedKey(input: LocalProviderRevisionRequest): Promise<LocalProviderStatus>;
}
function status(value: unknown): LocalProviderStatus {
  if (!isLocalProviderStatus(value)) throw Error('invalid_frame');
  return value;
}
export function localProviderClient(send: Send): LocalProviderClient {
  return {
    async providerStatus() {
      return status(await send('provider.status', {}));
    },
    async providerCheck() {
      const value = await send('provider.check', {}, CHECK_TIMEOUT_MS);
      if (!isLocalProviderCheckResponse(value)) throw Error('invalid_frame');
      return value;
    },
    async providerSet(input) {
      const request = validatedParams(input, isLocalProviderSetRequest);
      return status(await send('provider.set', request));
    },
    async providerDisconnect(input) {
      const request = validatedParams(input, isLocalProviderRevisionRequest);
      return status(await send('provider.disconnect', request));
    },
    async providerRemoveSavedKey(input) {
      const request = validatedParams(input, isLocalProviderRevisionRequest);
      return status(await send('provider.removeSavedKey', request));
    },
  };
}
