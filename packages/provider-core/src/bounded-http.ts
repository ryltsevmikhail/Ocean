/** Abort waiting without implying that the underlying external effect was cancelled. */
export async function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    void pending.catch(() => {});
    throw signal.reason;
  }
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException('request aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

/** A stalled injected reader must not defeat the adapter deadline. */
export async function* abortableChunks(
  chunks: AsyncIterable<string>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal?.aborted === true) throw signal.reason;
      const result = await withAbort(iterator.next(), signal);
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    // A stuck generator may also have a stuck return; do not wait past abort.
    void iterator.return?.().catch(() => {});
  }
}

/** Consume bytes through the streaming seam; never allocate an unbounded text body. */
export async function readBoundedText(
  chunks: AsyncIterable<string>,
  maxBytes: number,
): Promise<string> {
  let body = '',
    bytes = 0;
  for await (const chunk of chunks) {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) throw new Error('HTTP body exceeds limit');
    body += chunk;
  }
  return body;
}
