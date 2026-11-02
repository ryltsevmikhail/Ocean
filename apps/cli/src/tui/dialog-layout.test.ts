import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { renderFrame, type RunViewData } from './view.js';
import { initialUiState, reduceKey } from './state.js';
import { decodeKeys } from './keys.js';

function run(text: string): RunViewData {
  return {
    taskRunId: taskRunId('tr_dialog'),
    aggregate: null,
    events: [],
    liveMode: null,
    stream: [{ kind: 'text', text }],
  };
}
function render(text: string, scroll = 0): string {
  return renderFrame({
    ui: { ...initialUiState(), dialogScroll: scroll },
    runs: [run(text)],
    model: 'fake',
    provider: 'fake',
    size: { columns: 80, rows: 24 },
  });
}
it('starts with editable input and gives the main screen to the dialogue', () => {
  expect(initialUiState().focus).toBe('prompt');
  const frame = render('A readable answer');
  expect(frame).toContain('A readable answer');
  expect(frame).not.toContain('DETAILS');
  expect(frame).not.toContain('EVENTS');
  expect(frame).not.toContain('RUNS');
  expect(frame).not.toContain('provider_tokens');
});
it('uses most rows for the reply and scrolls back through a long answer', () => {
  const text = Array.from(
    { length: 70 },
    (_, index) => `answer line ${String(index).padStart(2, '0')}`,
  ).join('\n');
  const newest = render(text);
  expect(newest).toContain('answer line 69');
  expect(newest).toContain('answer line 55');
  expect(newest).not.toContain('answer line 00');
  const older = render(text, 50);
  expect(older).toContain('answer line 10');
  expect(older).not.toContain('answer line 69');
});
it('scrolls from the input without losing the draft or focus', () => {
  const before = { ...initialUiState(), prompt: 'keep this draft', cursor: 15 };
  const key = decodeKeys('\x1b[5~').keys[0];
  if (key === undefined) throw new Error('missing page-up');
  const after = reduceKey(before, key, {
    runCount: 1,
    eventCount: 0,
    dialogCount: 70,
    pageSize: 16,
  });
  expect(after.state.dialogScroll).toBe(16);
  expect(after.state.prompt).toBe(before.prompt);
  expect(after.state.focus).toBe('prompt');
});
it('opens task, event and detail panels explicitly and Escape restores the draft', () => {
  const context = { runCount: 1, eventCount: 0 };
  for (const [sequence, focus] of [
    ['\x1bOQ', 'runs'],
    ['\x1bOR', 'events'],
    ['\x1bOS', 'details'],
  ] as const) {
    const key = decodeKeys(sequence).keys[0];
    if (key === undefined) throw new Error('missing panel key');
    const before = { ...initialUiState(), prompt: 'draft' };
    const opened = reduceKey(before, key, context);
    expect(opened.state.focus).toBe(focus);
    const closed = reduceKey(opened.state, { type: 'escape' }, context);
    expect(closed.state.focus).toBe('prompt');
    expect(closed.state.prompt).toBe('draft');
  }
});
