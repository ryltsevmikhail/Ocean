/**
 * ACP agent tests with a provider attached.
 *
 * A scripted provider stands in for the model, so streaming updates, usage
 * settlement, typed failures and cancellation are asserted deterministically.
 */

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import type { JsonRpcId, JsonRpcMessage } from '@runnets/contracts';
import type { TaskRunService } from '@runnets/application';
import type { ModelRequest, ProviderEvent, ProviderPort } from '@runnets/provider-core';
import { ProviderError } from '@runnets/provider-core';

import { AcpAgent } from './agent.js';
import { JsonRpcPeer } from './transport.js';
import { createService } from '../lifecycle.js';
import { turnTaskRunId } from './session.js';

interface Harness {
  readonly service: TaskRunService;
  request(method: string, params: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params: unknown): void;
  frames(): readonly JsonRpcMessage[];
  close(): void;
}

function harness(provider: ProviderPort): Harness {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const peer = new JsonRpcPeer({ input: toAgent, output: fromAgent });
  const service = createService();
  new AcpAgent(peer, service, { provider }).attach();

  const frames: JsonRpcMessage[] = [];
  const waiters = new Map<JsonRpcId, (message: JsonRpcMessage) => void>();
  const reader = createInterface({ input: fromAgent });
  reader.on('line', (line) => {
    const message = JSON.parse(line) as JsonRpcMessage;
    frames.push(message);
    if ('id' in message && !('method' in message)) {
      const waiter = waiters.get(message.id);
      if (waiter !== undefined) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });

  let nextId = 0;
  return {
    service,
    request(method, params) {
      nextId += 1;
      const id = nextId;
      const promise = new Promise<JsonRpcMessage>((resolve) => waiters.set(id, resolve));
      toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise;
    },
    notify(method, params) {
      toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    frames: () => frames,
    close() {
      reader.close();
      toAgent.end();
    },
  };
}

function resultOf(message: JsonRpcMessage): Record<string, unknown> {
  if (!('result' in message)) throw new Error(`expected a result, got ${JSON.stringify(message)}`);
  return message.result as Record<string, unknown>;
}

function updatesOf(client: Harness): Array<Record<string, unknown>> {
  return client
    .frames()
    .filter((frame) => 'method' in frame && frame.method === 'session/update')
    .map(
      (frame) =>
        (
          frame as unknown as {
            params: { update: Record<string, unknown> };
          }
        ).params.update,
    );
}

async function openSession(client: Harness, model?: string): Promise<string> {
  const params: Record<string, unknown> = { cwd: '/tmp/workspace' };
  if (model !== undefined) params['model'] = model;
  return String(resultOf(await client.request('session/new', params))['sessionId']);
}

function scriptedProvider(
  events: readonly ProviderEvent[],
  capture?: { request: ModelRequest | null },
): ProviderPort {
  return {
    id: 'fake',
    models: ['fake-model', 'fake-reasoner'],
    capabilities: { streaming: true, reasoning: true, usage: true },
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      if (capture !== undefined) capture.request = request;
      for (const event of events) yield event;
    },
  };
}

function blockingProvider(reached: () => void): ProviderPort {
  return {
    id: 'fake',
    models: ['fake-model'],
    capabilities: { streaming: true, reasoning: true, usage: true },
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      yield { type: 'text_delta', text: 'partial' };
      reached();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted === true) {
          resolve();
          return;
        }
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new DOMException('The operation was aborted', 'AbortError');
    },
  };
}

describe('ACP agent with a provider', () => {
  it('advertises provider models on initialize', async () => {
    const client = harness(scriptedProvider([]));
    const result = resultOf(await client.request('initialize', { protocolVersion: 1 }));
    const models = result['models'] as {
      currentModelId: string;
      availableModels: Array<{ id: string }>;
    };

    expect(models.currentModelId).toBe('fake-model');
    expect(models.availableModels.map((model) => model.id)).toEqual([
      'fake-model',
      'fake-reasoner',
    ]);
    client.close();
  });

  it('streams thinking and reply chunks, records usage and succeeds', async () => {
    const client = harness(
      scriptedProvider([
        { type: 'reasoning_delta', text: 'plan' },
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
    );
    const sessionId = await openSession(client);

    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(resultOf(response)['stopReason']).toBe('end_turn');
    const updates = updatesOf(client);
    expect(updates.some((update) => update['sessionUpdate'] === 'agent_thought_chunk')).toBe(true);
    const state = await client.service.state(turnTaskRunId(sessionId, 1));
    expect(state.status).toBe('succeeded');
    expect(state.status === 'absent' ? 0 : state.budget.consumed.provider_tokens).toBe(15);
    client.close();
  });

  it('uses the model selected for the session', async () => {
    const capture: { request: ModelRequest | null } = { request: null };
    const client = harness(scriptedProvider([], capture));
    const sessionId = await openSession(client, 'fake-reasoner');

    await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(capture.request?.model).toBe('fake-reasoner');
    client.close();
  });

  it('turns a provider error into a failed run and a refusal', async () => {
    const client = harness(
      scriptedProvider([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: new ProviderError('auth', 'invalid api key') },
      ]),
    );
    const sessionId = await openSession(client);

    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(resultOf(response)['stopReason']).toBe('refusal');
    const state = await client.service.state(turnTaskRunId(sessionId, 1));
    expect(state.status).toBe('failed');
    if (state.status !== 'absent') {
      expect(state.terminal?.failure?.code).toBe('provider_error');
      expect(state.terminal?.failure?.message).toContain('auth');
    }
    const messages = updatesOf(client).filter(
      (update) => update['sessionUpdate'] === 'agent_message_chunk',
    );
    expect(JSON.stringify(messages)).toContain('invalid api key');
    client.close();
  });

  it('refuses a completion without usage evidence', async () => {
    const client = harness(
      scriptedProvider([
        { type: 'text_delta', text: 'Hello' },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
    );
    const sessionId = await openSession(client);

    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(resultOf(response)['stopReason']).toBe('refusal');
    const state = await client.service.state(turnTaskRunId(sessionId, 1));
    expect(state.status).toBe('failed');
    client.close();
  });

  it('keeps an interrupted provider outcome unknown after session/cancel', async () => {
    let markReached: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const client = harness(blockingProvider(() => markReached()));
    const sessionId = await openSession(client);

    const promptPromise = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await reached;
    client.notify('session/cancel', { sessionId });
    const response = await promptPromise;

    expect(resultOf(response)['stopReason']).toBe('refusal');
    expect((await client.service.state(turnTaskRunId(sessionId, 1))).status).toBe('cancelling');
    expect(
      (await client.service.events(turnTaskRunId(sessionId, 1))).map((event) => event.type),
    ).not.toContain('task_run.cancelled');
    expect(JSON.stringify(updatesOf(client))).toContain('billing may be unknown');
    client.close();
  });
});
