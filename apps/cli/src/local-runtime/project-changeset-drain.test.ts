import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { CodingPanelQueries } from './coding-panel.js';

it('bounds capture jobs and finishes an accepted snapshot even after its caller detaches', async () => {
  const f = await codingWorkflowFixture('direct');
  const panels = new CodingPanelQueries(f.runtime, f.runtime.openProfileReads!());
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = f.runtime.codingChanges.capture.bind(f.runtime.codingChanges);
  // Pause at the application boundary; still execute the real Git capture and receipt.
  const spy = vi.spyOn(f.runtime.codingChanges, 'capture').mockImplementation(async (...args) => {
    await barrier;
    return capture(...args);
  });
  try {
    writeFileSync(join(f.worktree, 'math.cjs'), 'changed\n');
    const q = { workspaceId: 'ws_ocean', roomId: f.room, taskId: 'task', expectedPolicyVersion: 1 };
    const connection = new AbortController();
    const start = (requestId: string, signal = new AbortController().signal) =>
      panels.dispatch('coding.changesets.capture', { ...q, requestId }, signal);
    const first = start('first', connection.signal);
    const duplicate = start('first');
    const second = start('second');
    expect(await start('excess')).toEqual({ error: { code: 'query_limit' } });
    connection.abort();

    let drained = false;
    const drain = panels.drain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(await start('late')).toEqual({ error: { code: 'runtime_draining' } });
    release();

    const saved = await first;
    expect(saved).toMatchObject({ result: { taskId: 'task', fileCount: 1 } });
    expect(await duplicate).toEqual(saved);
    expect(await second).toEqual(saved);
    await drain;
    const next = new CodingPanelQueries(f.runtime, f.runtime.openProfileReads!());
    writeFileSync(join(f.worktree, 'math.cjs'), 'later\n');
    expect(
      await next.dispatch(
        'coding.changesets.capture',
        { ...q, requestId: 'first' },
        new AbortController().signal,
      ),
    ).toEqual(saved);
    await next.drain();
  } finally {
    release();
    await panels.drain();
    spy.mockRestore();
    f.close();
  }
});
