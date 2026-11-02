import { expect, it } from 'vitest';
import { ToolService, type ToolExecutorPort } from '@runnets/application';
import type {
  ChatMessage,
  ModelRequest,
  ProviderEvent,
  ProviderPort,
} from '@runnets/provider-core';
import { taskRunId } from '@runnets/domain';
import { createService } from '../lifecycle.js';
import { createTaskRun } from '../acp/session.js';
import { runTurn } from './turn.js';

async function setup(limit?: number) {
  const service = createService();
  const id = taskRunId('tr_tools');
  await createTaskRun({
    service,
    taskRunId: id,
    conversationId: 'cv_tools',
    workspaceId: 'ws_tools',
    parentTaskRunId: null,
    model: 'fake',
  });
  let invoked = 0;
  const executor: ToolExecutorPort = {
    definitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    prepare: () =>
      Promise.resolve({
        title: 'Read a.ts',
        kind: 'read',
        preview: 'a.ts',
        execute: () => {
          invoked++;
          return Promise.resolve({ output: 'const a = 1;', isError: false });
        },
      }),
  };
  const tools = new ToolService(executor, { review: () => Promise.resolve('reject') });
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'fake',
    models: ['fake'],
    capabilities: { streaming: true, usage: true, reasoning: true, toolCalls: true },
    async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push({ ...request, messages: [...request.messages] });
      if (requests.length === 1 || limit !== undefined) {
        yield { type: 'reasoning_delta', text: 'inspect' };
        yield {
          type: 'tool_call',
          call: { id: 'a', name: 'read_file', arguments: '{"path":"a.ts"}' },
        };
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'Fixed and verified' };
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      }
    },
  };
  return { service, id, tools, provider, requests, invoked: () => invoked };
}

it('continues through tool results and settles every model request before final completion', async () => {
  const h = await setup();
  const history: ChatMessage[] = [];
  const result = await runTurn({
    service: h.service,
    taskRunId: h.id,
    tools: h.tools,
    provider: h.provider,
    model: 'fake',
    messages: [{ role: 'user', content: 'fix a.ts' }],
    signal: new AbortController().signal,
    emit: () => {},
    onHistory: (messages) => history.push(...messages),
  });
  expect(result.kind).toBe('completed');
  expect(h.requests).toHaveLength(2);
  expect(h.invoked()).toBe(1);
  expect(h.requests[1]?.messages).toContainEqual({
    role: 'tool',
    toolCallId: 'a',
    content: 'const a = 1;',
  });
  expect(history).toContainEqual(
    expect.objectContaining({ role: 'assistant', reasoning: 'inspect' }),
  );
  const state = await h.service.state(h.id);
  expect(state.status === 'absent' ? 0 : state.budget.consumed.provider_tokens).toBe(8);
});

it('bounds model requests instead of looping forever', async () => {
  const h = await setup(2);
  const result = await runTurn({
    service: h.service,
    taskRunId: h.id,
    tools: h.tools,
    provider: h.provider,
    model: 'fake',
    messages: [{ role: 'user', content: 'loop' }],
    signal: new AbortController().signal,
    emit: () => {},
    maxModelRequests: 2,
  });
  expect(result.kind).toBe('failed');
  expect(result.stopReason).toBe('max_turn_requests');
  expect(h.requests).toHaveLength(2);
});

it('stops after an uncertain tool outcome rather than asking the model to repeat it', async () => {
  const h = await setup();
  const tools = new ToolService(
    {
      definitions: h.tools.definitions,
      prepare: () =>
        Promise.resolve({
          title: 'tool',
          kind: 'read',
          preview: '',
          execute: () =>
            Promise.resolve({ isError: true, uncertain: true, output: 'outcome unknown' }),
        }),
    },
    { review: () => Promise.resolve('reject') },
  );
  const result = await runTurn({
    service: h.service,
    taskRunId: h.id,
    tools,
    provider: h.provider,
    model: 'fake',
    messages: [{ role: 'user', content: 'task' }],
    signal: new AbortController().signal,
    emit: () => {},
  });
  expect(result.kind).toBe('uncertain');
  expect((await h.service.state(h.id)).status).toBe('reconciling');
  expect(h.requests).toHaveLength(1);
});
