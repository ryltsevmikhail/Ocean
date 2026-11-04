import { expect, it } from 'vitest';
import { abortableChunks, readBoundedText, withAbort } from './bounded-http.js';
it('bounds a pending send even when a substituted client ignores abort', async () => {
  const abort = new AbortController();
  const result = withAbort(new Promise<void>(() => {}), abort.signal);
  abort.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
it('bounds pending reads and handles a pre-aborted read without next', async () => {
  const abort = new AbortController();
  let nextCalls = 0;
  const iterator = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      nextCalls++;
      return new Promise<IteratorResult<string>>(() => {});
    },
  };
  const result = readBoundedText(abortableChunks(iterator, abort.signal), 20);
  abort.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(nextCalls).toBe(1);
  await expect(readBoundedText(abortableChunks(iterator, abort.signal), 20)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(nextCalls).toBe(1);
});
it('counts UTF-8 bytes before accumulating and closes the bounded reader', async () => {
  let closed = false;
  const chunks = (async function* () {
    try {
      yield 'я'.repeat(6);
      yield 'never';
    } finally {
      closed = true;
    }
  })();
  await expect(readBoundedText(chunks, 10)).rejects.toThrow('limit');
  expect(closed).toBe(true);
});

it('observes an already rejected operation when cancellation happened during dispatch', async () => {
  const signal = AbortSignal.abort();
  await expect(withAbort(Promise.reject(signal.reason), signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});
