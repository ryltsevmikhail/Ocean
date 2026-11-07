import { describe, expect, it } from 'vitest';

import { parseSse, type SseEvent } from './sse.js';

async function* chunks(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

async function parse(values: readonly string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSse(chunks(values))) events.push(event);
  return events;
}

describe('SSE parser', () => {
  it('parses one event terminated by a blank line', async () => {
    await expect(parse(['data: hello\n\n'])).resolves.toEqual([{ event: null, data: 'hello' }]);
  });

  it('reads the event field and strips one leading space from the value', async () => {
    await expect(parse(['event: message\ndata: payload\n\n'])).resolves.toEqual([
      { event: 'message', data: 'payload' },
    ]);
  });

  it('joins multi-line data with a newline', async () => {
    await expect(parse(['data: first\ndata: second\n\n'])).resolves.toEqual([
      { event: null, data: 'first\nsecond' },
    ]);
  });

  it('ignores comment lines used as keep-alives', async () => {
    await expect(parse([': keep-alive\ndata: value\n\n'])).resolves.toEqual([
      { event: null, data: 'value' },
    ]);
  });

  it('accepts CRLF framing', async () => {
    await expect(parse(['event: update\r\ndata: x\r\n\r\n'])).resolves.toEqual([
      { event: 'update', data: 'x' },
    ]);
  });

  it('reassembles events split across arbitrary chunk boundaries', async () => {
    await expect(parse(['data: he', 'llo\n', '\ndata: wor', 'ld\n\n'])).resolves.toEqual([
      { event: null, data: 'hello' },
      { event: null, data: 'world' },
    ]);
  });

  it('parses several events delivered in one chunk', async () => {
    await expect(parse(['data: a\n\ndata: b\n\n'])).resolves.toEqual([
      { event: null, data: 'a' },
      { event: null, data: 'b' },
    ]);
  });

  it('emits a trailing event that has no terminating blank line', async () => {
    await expect(parse(['data: tail'])).resolves.toEqual([{ event: null, data: 'tail' }]);
  });

  it('keeps an empty data payload as an event', async () => {
    await expect(parse(['data:\n\n'])).resolves.toEqual([{ event: null, data: '' }]);
  });

  it('yields nothing for a stream without data fields', async () => {
    await expect(parse(['event: ping\n\n'])).resolves.toEqual([]);
  });
});

async function strict(values: readonly string[], maxFrameBytes = 262144): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSse(chunks(values), {
    requireTerminatedFrames: true,
    maxFrameBytes,
  }))
    events.push(event);
  return events;
}
it('strict framing retains partial CRLF/multiline/comment behavior', async () => {
  await expect(
    strict([': ping\r\nevent: x\r\ndata: a\r', '\ndata: b\r\n\r', '\n']),
  ).resolves.toEqual([{ event: 'x', data: 'a\nb' }]);
});
it.each(['data: [DONE]', 'data: [DONE]\n', 'data: a\n\ndata: pending'])(
  'strict mode rejects pending final data %s',
  async (value) => {
    await expect(strict([value])).rejects.toThrow();
  },
);
it('strict mode bounds UTF-8 frames across chunks and resets at boundaries', async () => {
  await expect(strict(['data: ', 'я'.repeat(20)], 32)).rejects.toThrow();
  await expect(strict(['data: a\n\ndata: b\n\n'], 10)).resolves.toHaveLength(2);
});

it('counts split astral UTF-8 exactly at the frame byte boundary', async () => {
  await expect(strict(['data: \ud83d', '\ude01\n\n'], 12)).resolves.toEqual([
    { event: null, data: '😁' },
  ]);
});
