import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { TaskRunService } from '@runnets/application';
import { InMemoryCommandDedup, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import type { ProviderEvent, ProviderPort } from '@runnets/provider-core';
import { TuiApp } from './app.js';
import { anchorDialogue, renderFrame, type RunViewData } from './view.js';
import { initialUiState } from './state.js';
import { taskRunId } from '@runnets/domain';

function setup(provider: ProviderPort | null = null) {
  const input = new PassThrough();
  const output = new PassThrough();
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    dedup: new InMemoryCommandDedup(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-01T00:00:00Z') },
  });
  const app = new TuiApp({ input, output, service, provider, size: { columns: 100, rows: 30 } });
  return { input, output, app };
}
function reply(): ProviderPort {
  return {
    id: 'fake',
    models: ['fake'],
    capabilities: { streaming: true, reasoning: true, usage: true },
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: 'text_delta', text: 'A useful answer' };
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
it('paints one input chunk once instead of redrawing for every character', async () => {
  const { app, input, output } = setup();
  let frames = 0;
  output.on('data', () => {
    frames++;
  });
  try {
    await app.start();
    frames = 0;
    input.write('Привет '.repeat(80));
    expect(frames).toBe(1);
    expect(app.ui.prompt).toContain('Привет');
  } finally {
    app.stop();
  }
});
it('keeps conversation history across continuation TaskRuns and /new starts a blank conversation', async () => {
  const { app, input } = setup(reply());
  try {
    await app.start();
    input.write('first\r');
    await app.idle();
    input.write('second\r');
    await app.idle();
    expect(app.runCount).toBe(2);
    expect(app.frame()).toContain('first');
    expect(app.frame()).toContain('second');
    expect(app.frame()).toContain('A useful answer');
    input.write('/new\r');
    await app.idle();
    expect(app.frame()).not.toContain('A useful answer');
    expect(app.frame()).not.toContain('first');
    expect(app.frame()).toContain('Write a message below');
  } finally {
    app.stop();
  }
});
it('pins the reading position when new output arrives and follows the bottom only at offset zero', () => {
  const before = [
    { kind: 'text' as const, text: Array.from({ length: 70 }, (_, i) => `line-${i}`).join('\n') },
  ];
  const after = [{ kind: 'text' as const, text: before[0]?.text + '\nnew line\nnewer line' }];
  const initial = { ...initialUiState(), dialogScroll: 20 };
  const pinned = anchorDialogue(initial, before, after, 80);
  expect(pinned.dialogScroll).toBe(22);
  const run: RunViewData = {
    taskRunId: taskRunId('tr_pin'),
    aggregate: null,
    events: [],
    liveMode: null,
    stream: before,
  };
  const frame = (stream: typeof before, ui = initial) =>
    renderFrame({
      ui,
      runs: [{ ...run, stream }],
      model: 'fake',
      provider: 'fake',
      size: { columns: 80, rows: 24 },
    });
  const rows = (text: string) => text.split('\n').slice(3, -3);
  expect(rows(frame(before))).toEqual(rows(frame(after, pinned)));
  expect(anchorDialogue(initialUiState(), before, after, 80).dialogScroll).toBe(0);
});
it('refreshes committed status and usage while the model is still working', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let modelReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    modelReady = resolve;
  });
  const provider: ProviderPort = {
    ...reply(),
    async *stream(): AsyncIterable<ProviderEvent> {
      modelReady();
      await gate;
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const { app, input } = setup(provider);
  try {
    await app.start();
    input.write('work\r');
    await ready;
    expect(app.ui.busy).toBe(true);
    expect(app.selectedRun()?.aggregate?.status).toBe('running');
    expect(app.selectedRun()?.events.some((event) => event.type === 'attempt.started')).toBe(true);
    release();
    await app.idle();
    expect(app.frame()).toContain('tokens 7');
  } finally {
    release();
    app.stop();
  }
});
