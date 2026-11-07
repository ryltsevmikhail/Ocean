/**
 * Server-sent events parser.
 *
 * Reads an incremental text stream and yields complete events. Providers that
 * stream over SSE share this parser, so framing bugs are fixed once.
 *
 * Legacy callers may flush trailing data. Qualified adapters opt into bounded,
 * terminated frames: an EOF fragment is never proof of completion.
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

/** A framing failure, distinct from an iterator/transport failure. */
export class SseError extends Error {}

export interface SseOptions {
  readonly requireTerminatedFrames?: boolean;
  readonly maxFrameBytes?: number;
}

export async function* parseSse(
  chunks: AsyncIterable<string>,
  options: SseOptions = {},
): AsyncIterable<SseEvent> {
  const state: SseState = { event: null, data: [] };
  let buffer = '';
  let frameBytes = 0;
  let highSurrogate = false;
  const limit = options.maxFrameBytes ?? Infinity;
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit <= 0))
    throw new Error('invalid SSE frame limit');

  for await (const chunk of chunks) {
    // Scan before accumulation, including ignored fields/comments in the bound.
    // A decoded transport chunk can contain arbitrarily many bounded frames.
    for (const character of chunk) {
      const code = character.charCodeAt(0);
      const joinedSurrogate = highSurrogate && code >= 0xdc00 && code <= 0xdfff;
      frameBytes += Buffer.byteLength(character, 'utf8') - (joinedSurrogate ? 2 : 0);
      highSurrogate = character.length === 1 && code >= 0xd800 && code <= 0xdbff;
      if (frameBytes > limit) throw new SseError('SSE frame exceeds limit');
      if (character !== '\n') {
        buffer += character;
        continue;
      }
      const blank = buffer === '' || buffer === '\r';
      const event = applyLine(buffer, state);
      buffer = '';
      if (blank) frameBytes = 0;
      if (event !== null) yield event;
    }
  }

  if (options.requireTerminatedFrames === true) {
    if (buffer !== '' || state.data.length > 0) throw new SseError('unterminated SSE frame');
    return;
  }
  if (buffer !== '') {
    const event = applyLine(buffer, state);
    if (event !== null) yield event;
  }
  if (state.data.length > 0) yield { event: state.event, data: state.data.join('\n') };
}
