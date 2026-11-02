import { describe, expect, it } from 'vitest';

import { mapStream } from './stream.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function* stream(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function text(value: string): unknown {
  return { choices: [{ delta: { content: value }, finish_reason: null }] };
}

describe('incomplete DeepSeek stream', () => {
  it('reports a stream with no finish reason and no [DONE] as an error, not a completion', async () => {
    const events = await collect(mapStream(stream([frame(text('Hel')), frame(text('lo'))])));

    expect(events.slice(0, -1)).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(events.some((event) => event.type === 'completed')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'server', message: 'incomplete DeepSeek stream', retryable: false },
    });
  });

  it('does not dispatch a partially assembled tool call when the stream is cut off', async () => {
    const events = await collect(
      mapStream(
        stream([
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      function: { name: 'read_file', arguments: '{"path":' },
                    },
                  ],
                },
              },
            ],
          }),
        ]),
      ),
    );

    expect(events.some((event) => event.type === 'tool_call')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'incomplete DeepSeek stream' },
    });
  });

  it('forwards usage evidence and then fails instead of completing', async () => {
    const events = await collect(
      mapStream(
        stream([
          frame(text('partial')),
          frame({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        ]),
      ),
    );

    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: 'incomplete DeepSeek stream' },
    });
  });

  it('still completes when [DONE] terminates a stream that carried no finish reason', async () => {
    const events = await collect(mapStream(stream([frame(text('a')), DONE])));

    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'completed', stopReason: 'stop', rawStopReason: null },
    ]);
  });
});
