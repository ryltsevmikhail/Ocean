import { ProviderError } from './provider.js';
/** Node timers above signed 32-bit milliseconds overflow to 1ms, even if timeout accepts them. */
export function assertProviderTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw new ProviderError('invalid_request', 'invalid provider deadline', {
      dispatch: 'not_sent',
      retryable: false,
    });
}
