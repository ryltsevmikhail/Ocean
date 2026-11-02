import { describe, expect, it } from 'vitest';
import { mapStream } from './stream.js';
import { buildRequestBody } from './wire.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
async function* chunks(values: readonly unknown[]): AsyncIterable<string> {
  for (const value of values) yield `data: ${JSON.stringify(value)}\n\n`;
  yield 'data: [DONE]\n\n';
}
const call = (tool: unknown) => ({ choices: [{ delta: { tool_calls: [tool] } }] });

describe('tool protocol', () => {
  it('assembles argument fragments and interleaved tool indexes before completion', async () => {
    const events = await collect(
      mapStream(
        chunks([
          call({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"pa' } }),
          call({ index: 1, id: 'b', function: { name: 'list_files', arguments: '{}' } }),
          call({ index: 0, function: { arguments: 'th":"a.ts"}' } }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'a', name: 'read_file', arguments: '{"path":"a.ts"}' },
    });
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'b', name: 'list_files', arguments: '{}' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'completed', stopReason: 'tool_calls' });
  });
  it('serializes tools, assistant calls, reasoning and correlated tool results', () => {
    const body: unknown = JSON.parse(
      buildRequestBody({
        model: 'fake',
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
        messages: [
          {
            role: 'assistant',
            content: '',
            reasoning: 'inspect',
            toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }],
          },
          { role: 'tool', content: 'source', toolCallId: 'a' },
        ],
      }),
    );
    expect(body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'inspect',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: 'source' },
      ],
    });
  });
  it('rejects incomplete tool identity instead of reporting successful completion', async () => {
    const events = await collect(
      mapStream(chunks([call({ index: 0, function: { arguments: '{}' } })])),
    );
    expect(events.at(-1)?.type).toBe('error');
  });
});
