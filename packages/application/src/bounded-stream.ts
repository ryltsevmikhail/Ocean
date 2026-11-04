/** A fixed bound on host waiting, including next()/return() that ignore cancellation. */
import { ProviderError, type ProviderEvent } from './provider.js';

export interface BoundedStream {
  readonly signal: AbortSignal;
  assertWithinDeadline(): void;
  next(iterator: AsyncIterator<ProviderEvent>): Promise<IteratorResult<ProviderEvent>>;
  close(iterator: AsyncIterator<ProviderEvent> | undefined): void;
}
export function boundModelStream(owner: AbortSignal, timeoutMs: number): BoundedStream {
  const controller = new AbortController();
  // Relative waits use one monotonic clock, independent of the domain/admission wall clock.
  const expiresAt = performance.now() + timeoutMs;
  const expired = new ProviderError('timeout', 'model request deadline exceeded');
  let timedOut = false;
  let rejectBound!: (error: ProviderError) => void;
  const bound = new Promise<never>((_, reject) => {
    rejectBound = reject;
  });
  // A signal may already be aborted before next() attaches its race handler.
  void bound.catch(() => {});
  const abort = (error: ProviderError): void => {
    rejectBound(error);
    controller.abort();
  };
  const assertWithinDeadline = (): void => {
    if (timedOut || performance.now() >= expiresAt) {
      timedOut = true;
      abort(expired);
      throw expired;
    }
  };
  // Owner abort requests stop; only the original deadline ends evidence collection.
  const cancelled = (): void => controller.abort();
  owner.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort(expired);
    },
    Math.max(0, timeoutMs),
  );
  if (owner.aborted) cancelled();
  let reads = 0;
  return {
    assertWithinDeadline,
    signal: controller.signal,
    async next(iterator) {
      assertWithinDeadline();
      // Buffered ready events must not monopolize the microtask queue indefinitely.
      if (++reads % 64 === 0) {
        await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 0)), bound]);
        assertWithinDeadline();
      }
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            assertWithinDeadline();
            return iterator.next();
          }),
          bound,
        ]);
        assertWithinDeadline();
        return result;
      } catch (error) {
        assertWithinDeadline();
        throw error;
      }
    },
    close(iterator) {
      clearTimeout(timer);
      owner.removeEventListener('abort', cancelled);
      controller.abort();
      // return() can queue behind an uncooperative next(); observe, never await it.
      if (iterator?.return !== undefined)
        void Promise.resolve()
          .then(() => iterator.return!())
          .catch(() => {});
    },
  };
}
