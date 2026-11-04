import { expect, it } from 'vitest';
import { conversationId, taskRunId, unlimitedBudget, workspaceId } from '@runnets/domain';
import { InMemoryCommandDedup, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { TaskRunService } from './service.js';
import { executeStep } from './commands.js';
import { runTurn } from './turn.js';
import { beginAttempt, cancelRun } from './lifecycle.js';
import { ToolService } from './tools.js';
import type { ProviderEvent, ProviderPort } from './provider.js';

async function setup() {
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    dedup: new InMemoryCommandDedup(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
  });
  const id = taskRunId('tr_safety');
  const result = await executeStep(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_safety'),
      workspaceId: workspaceId('ws_safety'),
      parentTaskRunId: null,
      model: 'fake',
      policyId: 'pl_safety',
      budget: unlimitedBudget(),
    },
    0,
  );
  if (!result.ok) throw result.error;
  return { service, id };
}

for (const cancel of [false, true]) {
  it(`preserves uncertain effects without terminal cleanup (cancel=${cancel})`, async () => {
    const h = await setup();
    const controller = new AbortController();
    let dispatches = 0;
    const provider: ProviderPort = {
      id: 'fake',
      models: ['fake'],
      capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
      async *stream(): AsyncIterable<ProviderEvent> {
        dispatches++;
        yield { type: 'tool_call', call: { id: 'one', name: 'read', arguments: '{}' } };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
      },
    };
    const tools = new ToolService(
      {
        definitions: [],
        prepare: () =>
          Promise.resolve({
            title: 'read',
            kind: 'read',
            preview: '',
            execute: () => {
              if (cancel) controller.abort();
              throw new Error('effect outcome lost');
            },
          }),
      },
      { review: () => Promise.resolve('reject') },
    );
    const outcome = await runTurn({
      service: h.service,
      taskRunId: h.id,
      provider,
      tools,
      model: 'fake',
      messages: [],
      signal: controller.signal,
      emit: () => {},
    });
    expect(outcome.kind).toBe('uncertain');
    expect(dispatches).toBe(1);
    const state = await h.service.state(h.id);
    expect(state.status).toBe(cancel ? 'cancelling' : 'reconciling');
    const types = (await h.service.events(h.id)).map((event) => event.type);
    expect(types).not.toContain('task_run.failed');
    expect(types).not.toContain('task_run.cancelled');
  });
}

it('does not dispatch a provider or tools for an already cancelled turn', async () => {
  const h = await setup();
  const controller = new AbortController();
  controller.abort();
  let dispatches = 0;
  const provider: ProviderPort = {
    id: 'fake',
    models: ['fake'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    stream: () => {
      dispatches++;
      throw new Error('must not dispatch');
    },
  };
  const outcome = await runTurn({
    service: h.service,
    taskRunId: h.id,
    provider,
    model: 'fake',
    messages: [],
    signal: controller.signal,
    emit: () => {},
  });
  expect(outcome.kind).toBe('cancelled');
  expect(dispatches).toBe(0);
  expect((await h.service.state(h.id)).status).toBe('cancelled');
});

it('refuses an overlapping turn before it can dispatch the same run twice', async () => {
  const h = await setup();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = (): void => {};
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let dispatches = 0;
  const provider: ProviderPort = {
    id: 'fake',
    models: ['fake'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(): AsyncIterable<ProviderEvent> {
      dispatches++;
      entered();
      await held;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const input = {
    service: h.service,
    taskRunId: h.id,
    provider,
    model: 'fake',
    messages: [],
    signal: new AbortController().signal,
    emit: () => {},
  };
  const first = runTurn(input);
  await dispatched;
  const overlapping = await runTurn(input);
  expect(overlapping).toEqual({
    kind: 'failed',
    stopReason: 'refusal',
    text: 'turn already executing for this task run',
  });
  expect(dispatches).toBe(1);
  expect((await h.service.state(h.id)).status).toBe('running');
  release();
  expect((await first).kind).toBe('completed');
});

it('does not invent confirmed cancellation without quiescence, and handles an existing cancel request', async () => {
  const h = await setup();
  const input = {
    service: h.service,
    taskRunId: h.id,
    provider: null,
    model: 'fake',
    messages: [],
    signal: new AbortController().signal,
    emit: () => {},
  };
  const started = await beginAttempt(input);
  await executeStep(h.service, h.id, 'RequestCancel', { cause: 'client' }, started.state.version);
  const unknown = await cancelRun(input, started.attemptId, null, '', false);
  expect(unknown.kind).toBe('uncertain');
  expect((await h.service.state(h.id)).status).toBe('cancelling');
  expect((await h.service.events(h.id)).map((event) => event.type)).not.toContain(
    'task_run.cancelled',
  );
  const confirmed = await cancelRun(input, started.attemptId, null, '', true);
  expect(confirmed.kind).toBe('cancelled');
  expect((await h.service.state(h.id)).status).toBe('cancelled');
});

it('preserves usage while a locally aborted provider has no remote completion evidence', async () => {
  const h = await setup();
  const controller = new AbortController();
  const provider: ProviderPort = {
    id: 'fake',
    models: ['fake'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      controller.abort();
      throw new Error('stream connection lost after abort');
    },
  };
  const outcome = await runTurn({
    service: h.service,
    taskRunId: h.id,
    provider,
    model: 'fake',
    messages: [],
    signal: controller.signal,
    emit: () => {},
  });
  expect(outcome.kind).toBe('uncertain');
  const state = await h.service.state(h.id);
  expect(state.status).toBe('cancelling');
  if (state.status === 'absent') throw new Error('expected existing run');
  expect(state.budget.consumed.provider_tokens).toBe(5);
  expect((await h.service.events(h.id)).map((event) => event.type)).not.toContain(
    'task_run.cancelled',
  );
});
