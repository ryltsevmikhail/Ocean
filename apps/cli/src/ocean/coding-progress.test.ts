import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { codingProgress } from './coding-progress.js';
it('renders trusted tool status locally with escaped terminal controls', () => {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', (chunk) => {
    output += String(chunk);
  });
  codingProgress(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call',
      title: 'run_test',
      kind: 'execute',
      status: 'pending',
    },
    stream,
  );
  expect(output).toContain('"kind":"execute"');
  codingProgress(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'exitCode=0\u001b[2J' } }],
    },
    stream,
  );
  expect(output).toContain('exitCode=0');
  expect(output).not.toContain('\u001b');
});
