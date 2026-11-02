/**
 * Server-sent events parser.
 *
 * Reads an incremental text stream and yields complete events. Providers that
 * stream over SSE share this parser, so framing bugs are fixed once.
 *
 * Unlike a browser `EventSource`, a final event without a terminating blank
 * line is still dispatched: providers close the connection right after the
 * last frame, and dropping its usage or finish reason would corrupt a turn.
 */

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

interface SseState {
  event: string | null;
  data: string[];
}

/** Apply one raw SSE line to the parser state and return a dispatched event. */
function applyLine(line: string, state: SseState): SseEvent | null {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;

  if (normalized === '') {
    if (state.data.length === 0) return null;
    const parsed: SseEvent = { event: state.event, data: state.data.join('\n') };
    state.event = null;
    state.data = [];
    return parsed;
  }
  if (normalized.startsWith(':')) return null;

  const colon = normalized.indexOf(':');
  const field = colon === -1 ? normalized : normalized.slice(0, colon);
  const value = colon === -1 ? '' : normalized.slice(colon + 1).replace(/^ /, '');
  if (field === 'event') state.event = value;
  else if (field === 'data') state.data.push(value);
  return null;
}

export async function* parseSse(chunks: AsyncIterable<string>): AsyncIterable<SseEvent> {
  const state: SseState = { event: null, data: [] };
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = applyLine(line, state);
      if (event !== null) yield event;
      newline = buffer.indexOf('\n');
    }
  }

  if (buffer !== '') {
    const event = applyLine(buffer, state);
    if (event !== null) yield event;
  }
  if (state.data.length > 0) yield { event: state.event, data: state.data.join('\n') };
}
