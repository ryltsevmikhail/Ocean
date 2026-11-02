/**
 * App-level tests: injected streams, an in-memory service and scripted
 * providers drive the UI. `TuiApp.idle()` replaces timers, so every assertion
 * is synchronous with respect to the work the input started.
 */

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';
import type { ModelRequest, ProviderEvent, ProviderPort } from '@runnets/provider-core';
import { ProviderError } from '@runnets/provider-core';
import { taskRunId } from '@runnets/domain';

import { createService } from '../lifecycle.js';
import { TuiApp } from './app.js';

const MODEL = 'fake-model';
const SIZE = { columns: 100, rows: 30 };
const CAPABILITIES = { streaming: true, reasoning: true, usage: true } as const;

interface Streams {
  readonly input: PassThrough;
  readonly output: PassThrough;
}

function streams(): Streams {
  return { input: new PassThrough(), output: new PassThrough() };
}

function readAll(stream: PassThrough): string {
  let text = '';
  for (;;) {
    const chunk: unknown = stream.read();
    if (chunk === null || chunk === undefined) break;
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return text;
}

function scripted(events: readonly ProviderEvent[], requests: ModelRequest[] = []): ProviderPort {
  return {
    id: 'fake',
    models: [MODEL],
    capabilities: CAPABILITIES,
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      // Snapshot the history: the host appends the reply after the stream ends.
      requests.push({ model: request.model, messages: [...request.messages] });
      for (const event of events) yield event;
    },
  };
}

function replyEvents(text = 'Hello'): readonly ProviderEvent[] {
  return [
    { type: 'reasoning_delta', text: 'think' },
    { type: 'text_delta', text: text.slice(0, 3) },
    { type: 'text_delta', text: text.slice(3) },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
  ];
}

function appOf(harness: Streams, provider: ProviderPort | null): TuiApp {
  return new TuiApp({
    input: harness.input,
    output: harness.output,
    service: createService(),
    provider,
    size: SIZE,
  });
}

describe('TuiApp', () => {
  it('creates the first run of the session on start and paints the panels', async () => {
    const harness = streams();
    const app = appOf(harness, scripted([]));

    await app.start();

    expect(app.runCount).toBe(1);
    expect(app.selectedRun()?.taskRunId).toBe(taskRunId('tr_tui_0001'));
    expect(app.selectedRun()?.aggregate?.status).toBe('created');
    expect(app.ui.focus).toBe('prompt');
    expect(app.frame()).toContain('tr_tui_0001');
    expect(readAll(harness.output)).toContain('tr_tui_0001');

    app.stop();
  });

  it('creates and selects further runs with n and moves selection with j/k', async () => {
    const harness = streams();
    const app = appOf(harness, scripted([]));
    await app.start();

    harness.input.write('\x1bOQn');
    await app.idle();
    expect(app.runCount).toBe(2);
    expect(app.ui.selectedIndex).toBe(1);
    expect(app.frame()).toContain('tr_tui_0002');

    harness.input.write('k');
    expect(app.ui.selectedIndex).toBe(0);
    harness.input.write('\u001b[B');
    expect(app.ui.selectedIndex).toBe(1);

    app.stop();
  });

  it('streams a turn into the live panel and shows committed results', async () => {
    const harness = streams();
    const requests: ModelRequest[] = [];
    const app = appOf(harness, scripted(replyEvents(), requests));
    await app.start();

    // Enter focuses the prompt from the run list; a second Enter sends.
    harness.input.write('\r');
    harness.input.write('hi there');
    harness.input.write('\r');
    await app.idle();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: 'hi there' }]);
    expect(app.ui.busy).toBe(false);
    expect(app.selectedRun()?.aggregate?.status).toBe('succeeded');

    const frame = app.frame();
    expect(frame).toContain('Hello');
    expect(frame).toContain('hi there');
    expect(frame).not.toContain('think');
    expect(frame).toContain('tokens 3');
    expect(frame).toContain('turn completed (end_turn)');
    harness.input.write('\x1b[15~');
    expect(app.frame()).toContain('Thinking');
    harness.input.write('\x1bOR');
    expect(app.frame()).toContain('attempt.usage_recorded');
    expect(app.frame()).toContain('task_run.succeeded');
    harness.input.write('\x1bOS');
    expect(app.frame()).toContain('provider_tokens: 3 / unlimited');

    app.stop();
  });

  it('continues on a fresh run after the selected run became terminal', async () => {
    const harness = streams();
    const requests: ModelRequest[] = [];
    const app = appOf(harness, scripted(replyEvents(), requests));
    await app.start();

    harness.input.write('\r');
    harness.input.write('first');
    harness.input.write('\r');
    await app.idle();

    harness.input.write('second');
    harness.input.write('\r');
    await app.idle();

    expect(app.runCount).toBe(2);
    expect(app.ui.selectedIndex).toBe(1);
    expect(app.selectedRun()?.taskRunId).toBe(taskRunId('tr_tui_0002'));
    expect(app.selectedRun()?.aggregate?.status).toBe('succeeded');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'second' },
    ]);

    app.stop();
  });

  it('runs a deterministic turn when no provider is configured', async () => {
    const harness = streams();
    const app = appOf(harness, null);
    await app.start();

    harness.input.write('\r');
    harness.input.write('hello');
    harness.input.write('\r');
    await app.idle();

    expect(app.selectedRun()?.aggregate?.status).toBe('succeeded');
    expect(app.frame()).toContain('deterministic turn (no provider configured)');

    app.stop();
  });

  it('reports a failed turn without leaving the UI busy', async () => {
    const harness = streams();
    const provider = scripted([{ type: 'error', error: new ProviderError('server', 'boom') }]);
    const app = appOf(harness, provider);
    await app.start();

    harness.input.write('\r');
    harness.input.write('go');
    harness.input.write('\r');
    await app.idle();

    expect(app.ui.busy).toBe(false);
    expect(app.ui.status).toBe('turn failed (refusal)');
    expect(app.selectedRun()?.aggregate?.status).toBe('failed');
    expect(app.frame()).toContain('turn failed (refusal)');

    app.stop();
  });
});
