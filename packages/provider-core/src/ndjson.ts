/** Strict LF records (CRLF accepted). An unterminated EOF is never a terminal record. */
export async function* parseNdjson(
  chunks: AsyncIterable<string>,
): AsyncIterable<Record<string, unknown>> {
  let pending = '',
    total = 0;
  for await (const chunk of chunks) {
    total += Buffer.byteLength(chunk, 'utf8');
    if (total > 8 * 1024 * 1024) throw Error('NDJSON total exceeds limit');
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      if (Buffer.byteLength(line, 'utf8') > 256 * 1024) throw Error('NDJSON record exceeds limit');
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw Error('NDJSON object required');
      yield value as Record<string, unknown>;
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending, 'utf8') > 256 * 1024) throw Error('NDJSON record exceeds limit');
  }
  if (pending !== '') throw Error('unterminated NDJSON');
}
