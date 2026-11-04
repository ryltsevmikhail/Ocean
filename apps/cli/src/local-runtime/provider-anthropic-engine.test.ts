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
import { createAnthropicProvider } from '@runnets/provider-anthropic';
import type { HttpClient, HttpRequest } from '@runnets/provider-core';

it('continues the real engine through native tool_use/result with one recorded effect and two accounted requests', async () => {
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    dedup: new InMemoryCommandDedup(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-04T00:00:00Z') },
  });
  const id = taskRunId('tr_anthropic');
  const created = await executeStep(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_anthropic'),
      workspaceId: workspaceId('ws_anthropic'),
      parentTaskRunId: null,
      model: 'claude-haiku-5-5',
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
      ).toHaveLength(1);
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
          expect(records).toMatchObject([{ id: call.id, outcome: 'started' }]);
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
  const frame = (type: string, fields: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  const httpClient: HttpClient = {
    async send(request) {
      requests.push(request);
      const first = requests.length === 1;
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw Error('unbounded reader');
        },
        async *stream() {
          yield frame('message_start', {
            message: {
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-5-5',
              content: [],
              usage: {
                input_tokens: first ? 5 : 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 1,
              },
            },
          });
          yield frame('content_block_start', {
            index: 0,
            content_block: first
              ? { type: 'tool_use', id: 'native_call', name: 'write_file', input: {} }
              : { type: 'text', text: '' },
          });
          yield frame('content_block_delta', {
            index: 0,
            delta: first
              ? { type: 'input_json_delta', partial_json: '{"content":"after"}' }
              : { type: 'text_delta', text: 'Final answer' },
          });
          yield frame('content_block_stop', { index: 0 });
          yield frame('message_delta', {
            delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: first ? 2 : 3 },
          });
          yield frame('message_stop');
        },
      };
    },
  };
  const outcome = await runTurn({
    service,
    taskRunId: id,
    provider: createAnthropicProvider({ apiKey: 'fixture-key', httpClient }),
    tools,
    model: 'claude-haiku-5-5',
    messages: [{ role: 'user', content: 'Record the fixture edit' }],
    signal: new AbortController().signal,
    emit: () => {},
  });
  expect(outcome).toEqual({ kind: 'completed', stopReason: 'end_turn', text: 'Final answer' });
  expect(requests).toHaveLength(2);
  expect(effects).toEqual(['{"content":"after"}']);
  expect(trace).toEqual(['claim', 'effect', 'settle:completed']);
  expect(records).toMatchObject([{ tool: 'write_file', outcome: 'completed' }]);
  const body = JSON.parse(requests[1]!.body!) as { messages: unknown[] };
  expect(body.messages.slice(-2)).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'native_call', name: 'write_file', input: { content: 'after' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'native_call', content: 'fixture recorded' }],
    },
  ]);
  expect(await service.state(id)).toMatchObject({
    status: 'succeeded',
    attemptCount: 1,
    budget: { consumed: { provider_tokens: 20 } },
  });
  expect(
    (await service.events(id)).filter((event) => event.type === 'attempt.model_request_settled'),
  ).toHaveLength(2);
});
