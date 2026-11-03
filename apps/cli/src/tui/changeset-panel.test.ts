import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { decodeKeys } from './keys.js';
import { initialUiState, reduceKey } from './state.js';
import { renderFrame, navigationContext, type FrameInput } from './view.js';
it('opens F6 changeset independently and scrolls every row without editing the prompt', () => {
  expect(decodeKeys('\x1b[17~').keys).toEqual([{ type: 'panel', panel: 'changeset' }]);
  const ui = reduceKey(
    { ...initialUiState(), prompt: 'keep draft', cursor: 10 },
    { type: 'panel', panel: 'changeset' },
    { runCount: 1, eventCount: 0 },
  ).state;
  expect(
    reduceKey(ui, { type: 'panel', panel: 'changeset' }, { runCount: 1, eventCount: 0 }).state
      .focus,
  ).toBe('changeset');
  const frame: FrameInput = {
    ui,
    model: 'fixture',
    provider: null,
    size: { columns: 100, rows: 16 },
    runs: [
      {
        taskRunId: taskRunId('tr_panel'),
        aggregate: null,
        events: [],
        stream: [],
        liveMode: null,
        codingLines: [
          'Changeset exact-hash\x1b[31m',
          ...Array.from({ length: 100 }, (_, n) => 'diff line ' + n),
          'FINAL DIFF ROW',
        ],
      },
    ],
  };
  expect(renderFrame(frame)).toContain('Changeset exact-hash');
  expect(renderFrame(frame)).not.toContain('\x1b');
  const end = reduceKey(ui, { type: 'end' }, { runCount: 1, ...navigationContext(frame) }).state;
  expect(renderFrame({ ...frame, ui: end })).toContain('FINAL DIFF ROW');
  expect(end.prompt).toBe('keep draft');
  expect(reduceKey(end, { type: 'escape' }, { runCount: 1, eventCount: 0 }).state.focus).toBe(
    'prompt',
  );
});
it('explains absence of coding task data in the changeset panel', () => {
  const frame: FrameInput = {
    ui: { ...initialUiState(), focus: 'changeset' },
    runs: [],
    model: 'fixture',
    provider: null,
    size: { columns: 100, rows: 16 },
  };
  expect(renderFrame(frame)).toContain('No coding changeset');
});
