/**
 * ACP agent tests: handshake, session lifecycle and provider-less turns.
 *
 * The agent is wired to an in-memory client exactly as the stdio transport
 * does, so frames are asserted on the wire and state is asserted on the
 * committed stream.
 */

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import type { JsonRpcId, JsonRpcMessage } from '@runnets/contracts';
import type { TaskRunService } from '@runnets/application';
import type { ProviderPort } from '@runnets/provider-core';

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

function harness(provider: ProviderPort | null = null): Harness {
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
  const response = await client.request('session/new', params);
  return String(resultOf(response)['sessionId']);
}

describe('ACP agent', () => {
  it('answers initialize with protocol version 1 and a local model', async () => {
    const client = harness();
    const result = resultOf(
      await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'desktop', version: '0.0.0' },
      }),
    );

    expect(result['protocolVersion']).toBe(1);
    expect(result['authMethods']).toEqual([]);
    expect((result['agentInfo'] as { name: string }).name).toBe('runnets');
    expect((result['models'] as { currentModelId: string }).currentModelId).toBe('runnets-local');
    client.close();
  });

  it('rejects a newer protocol version instead of guessing', async () => {
    const client = harness();
    const response = await client.request('initialize', { protocolVersion: 99 });

    expect('error' in response).toBe(true);
    client.close();
  });

  it('opens a conversation session and its first task run', async () => {
    const client = harness();
    const sessionId = await openSession(client);

    expect(sessionId).toBe('s_0001');
    const state = await client.service.state(turnTaskRunId(sessionId, 1));
    expect(state.status).toBe('created');
    client.close();
  });

  it('runs a deterministic prompt turn to completion and streams updates', async () => {
    const client = harness();
    const sessionId = await openSession(client);

    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say hello' }],
    });

    expect(resultOf(response)['stopReason']).toBe('end_turn');
    const updates = updatesOf(client);
    expect(updates.some((update) => update['sessionUpdate'] === 'agent_message_chunk')).toBe(true);
    expect((await client.service.state(turnTaskRunId(sessionId, 1))).status).toBe('succeeded');
    client.close();
  });

  it('starts a fresh task run for the next prompt in the same session', async () => {
    const client = harness();
    const sessionId = await openSession(client);

    await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    });
    const second = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });

    expect(resultOf(second)['stopReason']).toBe('end_turn');
    expect((await client.service.state(turnTaskRunId(sessionId, 1))).status).toBe('succeeded');
    expect((await client.service.state(turnTaskRunId(sessionId, 2))).status).toBe('succeeded');
    client.close();
  });

  it('rejects a prompt for an unknown session', async () => {
    const client = harness();
    const response = await client.request('session/prompt', {
      sessionId: 's_9999',
      prompt: [{ type: 'text', text: 'hi' }],
    });

    expect('error' in response).toBe(true);
    if (!('error' in response)) return;
    expect(response.error.code).toBe(-32_602);
    client.close();
  });

  it('requires cwd when opening a session', async () => {
    const client = harness();
    const response = await client.request('session/new', {});

    expect('error' in response).toBe(true);
    client.close();
  });

  it('rejects an unknown method with method-not-found', async () => {
    const client = harness();
    const response = await client.request('session/bogus', {});

    expect('error' in response).toBe(true);
    if (!('error' in response)) return;
    expect(response.error.code).toBe(-32_601);
    client.close();
  });
});
