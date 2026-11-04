/** A fixed bound on host waiting, including next()/return() that ignore cancellation. */
import { ProviderError, type ProviderEvent } from './provider.js';

export interface BoundedStream {
  readonly signal: AbortSignal;
  next(iterator: AsyncIterator<ProviderEvent>): Promise<IteratorResult<ProviderEvent>>;
  close(iterator: AsyncIterator<ProviderEvent> | undefined): void;
}
export function boundModelStream(owner: AbortSignal, timeoutMs: number): BoundedStream {
  const controller = new AbortController();
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
  // Owner abort requests stop; only the original deadline ends evidence collection.
  const cancelled = (): void => controller.abort();
  owner.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(
    () => abort(new ProviderError('timeout', 'model request deadline exceeded')),
    Math.max(0, timeoutMs),
  );
  if (owner.aborted) cancelled();
  return {
    signal: controller.signal,
    next: (iterator) => Promise.race([Promise.resolve().then(() => iterator.next()), bound]),
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
