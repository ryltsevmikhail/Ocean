import { expect, it } from 'vitest';
import { conversationId, taskRunId, unlimitedBudget, workspaceId } from '@runnets/domain';
import { InMemoryCommandDedup, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import {
  executeStep,
  runTurn,
  TaskRunService,
  ToolService,
  type ToolEffectRecord,
  type ToolJournalPort,
} from '@runnets/application';
import { createLocalProvider } from '@runnets/provider-local';
import { endpoint, qualification, version, tags, show } from '../../test-fixtures/local-model.js';
import type { HttpClient, HttpRequest } from '@runnets/provider-core';

it('continues the real engine through native local tools with two distinct recorded effects and three accounted requests', async () => {
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    dedup: new InMemoryCommandDedup(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-04T00:00:00Z') },
  });
  const id = taskRunId('tr_local');
  const created = await executeStep(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_local'),
      workspaceId: workspaceId('ws_local'),
      parentTaskRunId: null,
      model: 'qwen3:1.7b',
      policyId: 'pl_fixture',
      budget: unlimitedBudget(),
    },
    0,
  );
  if (!created.ok) throw created.error;
  const records: ToolEffectRecord[] = [],
    effects: string[] = [],
    trace: string[] = [];
  const journal: ToolJournalPort = {
    claim: async (callId, tool, context, fingerprint) => {
      await Promise.resolve();
      expect(
        (await service.events(id)).filter((e) => e.type === 'attempt.model_request_settled'),
      ).toHaveLength(records.length + 1);
      records.push({ id: callId, tool, ...context, fingerprint, outcome: 'started' });
      trace.push('claim');
      return true;
    },
    settle: async (callId, outcome) => {
      const index = records.findIndex((record) => record.id === callId),
        record = records[index];
      if (record === undefined) throw Error('missing claim');
      records[index] = { ...record, outcome };
      trace.push(`settle:${outcome}`);
    },
    pending: async () => records.filter((record) => record.outcome === 'started'),
    recover: async () => {
      throw Error('unexpected recovery');
    },
  };
  const tools = new ToolService(
    {
      definitions: [
        { name: 'write_file', description: 'Record fixture edit', parameters: { type: 'object' } },
      ],
      prepare: async (call) => ({
        title: 'Fixture edit',
        kind: 'edit',
        preview: 'record only',
        execute: async () => {
          expect(records.at(-1)).toMatchObject({ id: call.id, outcome: 'started' });
          effects.push(call.arguments);
          trace.push('effect');
          return { output: 'fixture recorded', isError: false };
        },
      }),
    },
    { review: async () => 'allow_once' },
    journal,
  );
  const requests: HttpRequest[] = [];
  let inference = 0;
  const httpClient: HttpClient = {
    async send(request) {
      requests.push(request);
      const path = new URL(request.url).pathname;
      const metadata = (
        { '/api/version': version, '/api/tags': tags, '/api/show': show } as Record<string, unknown>
      )[path];
      if (path === '/api/chat') {
        inference++;
        const events = await service.events(id);
        expect(events.filter((e) => e.type === 'attempt.model_request_started')).toHaveLength(
          inference,
        );
      }
      const round = inference;
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw Error('unbounded');
        },
        async *stream() {
          if (metadata) {
            yield JSON.stringify(metadata);
            return;
          }
          yield JSON.stringify({
            model: 'qwen3:1.7b',
            done: false,
            message: {
              role: 'assistant',
              content: round < 3 ? '' : 'Final answer',
              ...(round < 3
                ? {
                    tool_calls: [
                      { function: { name: 'write_file', arguments: { content: `after${round}` } } },
                    ],
                  }
                : {}),
            },
          }) + '\n';
          yield JSON.stringify({
            model: 'qwen3:1.7b',
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 2,
          }) + '\n';
        },
      };
    },
  };
  const outcome = await runTurn({
    service,
    taskRunId: id,
    provider: createLocalProvider({ endpoint, auth: { mode: 'none' }, qualification, httpClient }),
    tools,
    model: 'qwen3:1.7b',
    messages: [{ role: 'user', content: 'Record the fixture edit' }],
    signal: new AbortController().signal,
    emit: () => {},
  });
  expect(outcome).toEqual({ kind: 'completed', stopReason: 'end_turn', text: 'Final answer' });
  expect(requests).toHaveLength(12);
  expect(effects).toEqual(['{"content":"after1"}', '{"content":"after2"}']);
  expect(trace).toEqual([
    'claim',
    'effect',
    'settle:completed',
    'claim',
    'effect',
    'settle:completed',
  ]);
  expect(records).toMatchObject([
    { tool: 'write_file', outcome: 'completed' },
    { tool: 'write_file', outcome: 'completed' },
  ]);
  expect(new Set(records.map((r) => r.id)).size).toBe(2);
  const body = JSON.parse(requests[11]!.body!) as { messages: Record<string, unknown>[] };
  expect(body.messages.slice(-2)).toEqual([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'write_file', arguments: { content: 'after2' } } }],
    },
    { role: 'tool', tool_name: 'write_file', content: 'fixture recorded' },
  ]);
  expect(await service.state(id)).toMatchObject({
    status: 'succeeded',
    attemptCount: 1,
    budget: { consumed: { provider_tokens: 21 } },
  });
  expect(
    (await service.events(id)).filter((event) => event.type === 'attempt.model_request_settled'),
  ).toHaveLength(3);
});
