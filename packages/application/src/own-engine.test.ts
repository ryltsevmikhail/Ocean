import { expect, it } from 'vitest';
import { conversationId, taskRunId, unlimitedBudget, workspaceId } from '@runnets/domain';
import { InMemoryCommandDedup, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { executeStep } from './commands.js';
import type { ModelRequest, ProviderEvent, ProviderPort, ToolCall } from './provider.js';
import { TaskRunService } from './service.js';
import {
  ToolService,
  type ToolEffectRecord,
  type ToolJournalPort,
  type ToolResult,
} from './tools.js';
import { runTurn } from './turn.js';

type Scenario = 'completed' | 'uncertain' | 'lost' | 'denied';

async function setup(scenario: Scenario) {
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    dedup: new InMemoryCommandDedup(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-04T00:00:00Z') },
  });
  const id = taskRunId('tr_own_engine');
  const created = await executeStep(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_own_engine'),
      workspaceId: workspaceId('ws_own_engine'),
      parentTaskRunId: null,
      model: 'scripted',
      policyId: 'pl_own_engine',
      budget: unlimitedBudget(),
    },
    0,
  );
  if (!created.ok) throw created.error;

  // Ephemeral port evidence of application ordering, not restart durability.
  const records: ToolEffectRecord[] = [];
  const effects: string[] = [];
  const prepared: string[] = [];
  const reviews: string[] = [];
  const trace: string[] = [];
  const claimsAtEffect: ToolEffectRecord[][] = [];
  const journal: ToolJournalPort = {
    claim: async (callId, tool, context, fingerprint) => {
      // A caller that does not await the commit will execute before this boundary.
      await Promise.resolve();
      records.push({ id: callId, tool, ...context, fingerprint, outcome: 'started' });
      trace.push('claim');
      return true;
    },
    settle: (callId, outcome) => {
      const index = records.findIndex((record) => record.id === callId);
      const record = records[index];
      if (record === undefined) throw new Error('settlement without a claim');
      records[index] = { ...record, outcome };
      trace.push(`settle:${outcome}`);
      return Promise.resolve();
    },
    pending: () =>
      Promise.resolve(
        records.filter((record) => record.outcome === 'started' || record.outcome === 'uncertain'),
      ),
    recover: () => Promise.reject(new Error('recovery is outside this characterization')),
  };
  const tools = new ToolService(
    {
      definitions: [{ name: 'write_file', description: 'Edit', parameters: { type: 'object' } }],
      prepare: (call) => {
        prepared.push(call.id);
        return Promise.resolve({
          title: 'Edit a.ts',
          kind: 'edit',
          preview: 'a.ts: before -> after',
          execute: (): Promise<ToolResult> => {
            effects.push(call.id);
            claimsAtEffect.push(records.map((record) => ({ ...record })));
            trace.push('effect');
            if (scenario === 'lost') return Promise.reject(new Error('effect response lost'));
            return Promise.resolve(
              scenario === 'uncertain'
                ? { output: 'outcome unknown', isError: true, uncertain: true }
                : { output: 'a.ts updated', isError: false },
            );
          },
        });
      },
    },
    {
      review: (tool) => {
        reviews.push(tool.preview);
        return Promise.resolve(scenario === 'denied' ? 'reject' : 'allow_once');
      },
    },
    journal,
  );
  const calls: ToolCall[] = [
    { id: 'one', name: 'write_file', arguments: '{"path":"a.ts","content":"after"}' },
  ];
  if (scenario === 'uncertain' || scenario === 'lost') {
    calls.push({ id: 'two', name: 'write_file', arguments: '{"path":"b.ts"}' });
  }
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'scripted',
    models: ['scripted'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push({ ...request, messages: [...request.messages] });
      if (requests.length === 1) {
        for (const call of calls) yield { type: 'tool_call', call };
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Final answer' };
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      }
    },
  };
  const updates: string[] = [];
  const outcome = await runTurn({
    service,
    taskRunId: id,
    provider,
    tools,
    model: 'scripted',
    messages: [{ role: 'user', content: 'Edit a.ts' }],
    signal: new AbortController().signal,
    emit: (update) => {
      if (update.sessionUpdate === 'tool_call_update') updates.push(update.status);
    },
  });
  return {
    outcome,
    state: await service.state(id),
    events: await service.events(id),
    requests,
    records,
    effects,
    prepared,
    reviews,
    trace,
    claimsAtEffect,
    updates,
  };
}

it('owns model -> tool -> model in one attempt and awaits the claim before the effect', async () => {
  const h = await setup('completed');
  expect(h.outcome).toEqual({ kind: 'completed', stopReason: 'end_turn', text: 'Final answer' });
  expect(h.requests).toHaveLength(2);
  expect(h.effects).toEqual(['tr_own_engine_at_0001_r1_one']);
  expect(h.requests[1]?.messages).toContainEqual({
    role: 'tool',
    toolCallId: 'one',
    content: 'a.ts updated',
  });
  expect(h.state).toMatchObject({
    status: 'succeeded',
    attemptCount: 1,
    budget: { consumed: { provider_tokens: 8 } },
  });
  expect(h.events.filter((event) => event.type === 'attempt.started')).toHaveLength(1);
  expect(h.claimsAtEffect).toEqual([
    [
      {
        id: 'tr_own_engine_at_0001_r1_one',
        tool: 'write_file',
        taskRunId: 'tr_own_engine',
        attemptId: 'tr_own_engine_at_0001',
        fingerprint: '["write_file","{\\"path\\":\\"a.ts\\",\\"content\\":\\"after\\"}"]',
        outcome: 'started',
      },
    ],
  ]);
  expect(h.trace).toEqual(['claim', 'effect', 'settle:completed']);
  expect(h.records).toHaveLength(1);
  expect(h.records[0]?.outcome).toBe('completed');
});

for (const scenario of ['uncertain', 'lost'] as const) {
  it(`stops after one unknown effect without another tool or model dispatch (${scenario})`, async () => {
    const h = await setup(scenario);
    expect(h.outcome.kind).toBe('uncertain');
    expect(h.requests).toHaveLength(1);
    expect(h.effects).toEqual(['tr_own_engine_at_0001_r1_one']);
    expect(h.prepared).toEqual(['tr_own_engine_at_0001_r1_one']);
    expect(h.trace).toEqual(['claim', 'effect', 'settle:uncertain']);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.outcome).toBe('uncertain');
    expect(h.state).toMatchObject({ status: 'reconciling', attemptCount: 1, terminal: null });
    expect(h.events.filter((event) => event.type === 'attempt.started')).toHaveLength(1);
    const types = h.events.map((event) => event.type);
    expect(types).not.toContain('task_run.succeeded');
    expect(types).not.toContain('task_run.failed');
    expect(types).not.toContain('task_run.cancelled');
    expect(h.updates).toEqual(['failed']);
  });
}

it('returns a denied edit to the model without claiming or executing the effect', async () => {
  const h = await setup('denied');
  expect(h.prepared).toEqual(['tr_own_engine_at_0001_r1_one']);
  expect(h.reviews).toEqual(['a.ts: before -> after']);
  expect(h.effects).toEqual([]);
  expect(h.claimsAtEffect).toEqual([]);
  expect(h.records).toEqual([]);
  expect(h.trace).toEqual([]);
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]?.messages).toContainEqual({
    role: 'tool',
    toolCallId: 'one',
    content: 'denied: tool permission denied',
  });
  expect(h.outcome.kind).toBe('completed');
  expect(h.updates).toEqual(['failed']);
});
