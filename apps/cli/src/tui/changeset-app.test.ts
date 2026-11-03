import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { TuiApp } from './app.js';
import { runView, type RunEntry, type RunBookPort } from './runs.js';
it('loads and refreshes a private changeset panel without sending a turn or losing its draft', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  output.resume();
  const entry: RunEntry = {
    taskRunId: taskRunId('tr_draft'),
    aggregate: null,
    events: [],
    stream: [],
    liveMode: null,
  };
  const turn = vi.fn();
  const loadChangeset = vi.fn(async (value: RunEntry) => {
    value.codingLines = ['Changeset exact-' + loadChangeset.mock.calls.length];
  });
  const book: RunBookPort = {
    model: 'fixture',
    providerId: null,
    runs: [entry],
    views: () => [runView(entry)],
    restore: async () => {},
    add: async () => entry,
    reload: async () => {},
    openForTurn: async () => entry,
    turn,
    cancel: () => {},
    loadChangeset,
  };
  const app = new TuiApp({ input, output, book });
  try {
    await app.start();
    input.write('keep draft');
    input.write('\x1b[17~');
    await app.idle();
    expect(app.frame()).toContain('Changeset exact-1');
    input.write('\x1b[17~');
    await app.idle();
    expect(app.frame()).toContain('Changeset exact-2');
    expect(app.ui.prompt).toBe('keep draft');
    expect(app.ui.focus).toBe('changeset');
    expect(turn).not.toHaveBeenCalled();
  } finally {
    app.stop();
    await app.idle();
  }
});
it('renders observation failure as a panel error without dispatching another operation', async () => {
  const { refreshChangeset } = await import('./changeset.js');
  const entry: RunEntry = {
    taskRunId: taskRunId('tr_error'),
    aggregate: null,
    events: [],
    stream: [],
    liveMode: null,
  };
  const loadChangeset = vi.fn(async () => {
    throw Error('stale_capture');
  });
  await refreshChangeset({ loadChangeset } as unknown as RunBookPort, entry, () => {});
  expect(entry.codingLines).toEqual(['Changeset unavailable: stale_capture']);
  expect(loadChangeset).toHaveBeenCalledOnce();
});
