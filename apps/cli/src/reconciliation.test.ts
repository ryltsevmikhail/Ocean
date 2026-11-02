import { expect, it } from 'vitest';
import { TaskRunService, reconcileInterrupted } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { SequentialIdGenerator } from '@runnets/store';
import { taskRunId } from '@runnets/domain';
import { createTaskRun } from './acp/session.js';
import { executeStep } from './engine/commands.js';
import { runTurn } from './engine/turn.js';
import { createRuntime } from './runtime.js';
import { TuiSession } from './tui/session.js';

it('reconciles interrupted work without inventing stop evidence or restoring conversation history', async () => {
  const store = openSqliteStore({ path: ':memory:' });
  const service = new TaskRunService({
    log: store.log,
    dedup: store.dedup,
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-01T00:00:00Z') },
  });
  const id = taskRunId('tr_interrupted');
  try {
    await createTaskRun({
      service,
      taskRunId: id,
      conversationId: 'cv_restart',
      workspaceId: 'ws_restart',
      parentTaskRunId: null,
      model: 'fake',
    });
    for (const [type, payload] of [
      ['Admit', {}],
      ['Schedule', {}],
      [
        'StartAttempt',
        { attemptId: 'at_restart', reason: 'initial', provider: 'fake', model: 'fake' },
      ],
    ] as const) {
      const state = await service.state(id);
      const result = await executeStep(service, id, type, payload, state.version);
      expect(result.ok).toBe(true);
    }
    const context = { taskRunId: id, attemptId: 'at_restart' };
    expect(await store.tools.claim('invocation', 'write_file', context, 'fingerprint')).toBe(true);
    const recovery = await reconcileInterrupted(service, store.tools);
    expect((await service.state(id)).status).toBe('reconciling');
    expect(recovery.effects[0]?.outcome).toBe('uncertain');
    expect(recovery.tasks[0]?.reason).toContain('Automatic continuation is disabled');
    const version = (await service.state(id)).version;
    expect(await reconcileInterrupted(service, store.tools)).toEqual(recovery);
    expect((await service.state(id)).version).toBe(version);
    await expect(
      runTurn({
        service,
        taskRunId: id,
        model: 'fake',
        provider: null,
        messages: [],
        signal: new AbortController().signal,
        emit: () => {},
      }),
    ).rejects.toThrow('cannot start');
    const restored = new TuiSession({ service, provider: null });
    await expect(
      restored.sendTurn({
        taskRunId: id,
        prompt: 'continue',
        signal: new AbortController().signal,
        emit: () => {},
      }),
    ).rejects.toThrow('history unavailable');
    const cancelled = await executeStep(service, id, 'RequestCancel', { cause: 'user' }, version);
    expect(cancelled.ok).toBe(true);
    await reconcileInterrupted(service, store.tools);
    expect((await service.state(id)).status).toBe('cancelling');
    expect((await service.events(id)).map((event) => event.type)).not.toContain(
      'task_run.cancelled',
    );
  } finally {
    store.close();
  }
});

it('refuses a recovery promise backed by memory and keeps ephemeral explicit', async () => {
  expect(() => createRuntime({ mode: 'durable' })).toThrow('persistent');
  expect(() => createRuntime({ mode: 'durable', dbPath: ':memory:' })).toThrow('persistent');
  const runtime = createRuntime({ mode: 'ephemeral' });
  expect(runtime.durable).toBe(false);
  expect(await runtime.ready).toEqual({ tasks: [], effects: [] });
  runtime.close();
});
