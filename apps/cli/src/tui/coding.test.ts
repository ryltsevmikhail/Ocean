import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { DeepSeekProvider } from '@runnets/provider-deepseek';
import type { HttpClient, HttpRequest } from '@runnets/provider-core';
import { WorkspaceTools, type WorkspaceBackend } from '@runnets/tools-node';
import { createService } from '../lifecycle.js';
import { TuiApp } from './app.js';

it('reads, edits, approves a test command and finishes through the real DeepSeek SSE adapter', async () => {
  let source = 'export const add = (a, b) => a - b;';
  const actions: string[] = [];
  const backend: WorkspaceBackend = {
    read: () => Promise.resolve(source),
    list: () => Promise.resolve([]),
    write: (_path, content, expected) => {
      expect(source).toBe(expected);
      source = content;
      actions.push('edit');
      return Promise.resolve();
    },
    command: (program, args) => {
      expect(program).toBe('node');
      expect(args).toEqual(['test.mjs']);
      expect(source).toContain('a + b');
      actions.push('test');
      return Promise.resolve({ output: 'tests passed', isError: false });
    },
  };
  const requests: HttpRequest[] = [];
  const calls = [
    { name: 'read_file', args: { path: 'add.js' } },
    { name: 'replace_text', args: { path: 'add.js', old_text: 'a - b', new_text: 'a + b' } },
    { name: 'run_command', args: { program: 'node', args: ['test.mjs'], cwd: '.' } },
  ];
  const http: HttpClient = {
    send: (request) => {
      requests.push(request);
      const call = calls[requests.length - 1];
      return Promise.resolve({
        status: 200,
        ok: true,
        text: () => Promise.resolve(''),
        async *stream() {
          const delta =
            call === undefined
              ? { content: 'Fixed add.js; node test.mjs passed.' }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args) },
                    },
                  ],
                };
          yield `data: ${JSON.stringify({ choices: [{ delta, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`;
          yield 'data: [DONE]\n\n';
        },
      });
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const approvals: string[] = [];
  output.on('data', (chunk: Buffer) => {
    const frame = chunk.toString('utf8');
    if (frame.startsWith('Permission:')) {
      approvals.push(frame);
      input.write('y');
    }
  });
  const app = new TuiApp({
    input,
    output,
    service: createService(),
    provider: new DeepSeekProvider({ apiKey: 'fake', httpClient: http, timeoutMs: 0 }),
    executor: new WorkspaceTools(backend),
    size: { columns: 100, rows: 30 },
  });
  try {
    await app.start();
    input.write('Fix the addition bug and run tests\r');
    await app.idle();
    expect(app.ui.status).toBe('turn completed (end_turn)');
    expect(source).toContain('a + b');
    expect(actions).toEqual(['edit', 'test']);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toContain('a - b');
    expect(approvals[0]).toContain('a + b');
    expect(approvals[1]).toContain('test.mjs');
    expect(app.selectedRun()?.aggregate?.status).toBe('succeeded');
    expect(requests).toHaveLength(4);
    const last = JSON.parse(requests[3]?.body ?? '{}') as {
      messages: { role: string; content: string }[];
    };
    expect(last.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', content: 'tests passed' }),
    );
  } finally {
    app.stop();
    input.end();
    output.end();
  }
});
