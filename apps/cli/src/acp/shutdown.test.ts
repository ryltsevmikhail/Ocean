import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProviderPort } from '@runnets/provider-core';
import { taskRunId } from '@runnets/domain';

import { createService } from '../lifecycle.js';
import { AcpAgent } from './agent.js';
import { JsonRpcPeer } from './transport.js';

it('preserves unknown provider cancellation before a disconnected host closes its store', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const service = createService();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider: ProviderPort = {
    id: 'fake',
    models: ['fake-model'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(request) {
      const signal = request.signal;
      started();
      yield { type: 'text_delta', text: 'partial' };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      // A local transport abort cannot manufacture a provider terminal frame.
      throw new Error('provider transport lost after local abort');
    },
  };
  const agent = new AcpAgent(new JsonRpcPeer({ input, output }), service, { provider });
  try {
    const session = await agent.newSession({ cwd: '/workspace' });
    const turn = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    await ready;
    agent.shutdown();
    expect((await turn).stopReason).toBe('refusal');
    expect((await service.state(taskRunId(`tr_${session.sessionId}_t1`))).status).toBe(
      'cancelling',
    );
    expect(
      (await service.events(taskRunId(`tr_${session.sessionId}_t1`))).map((event) => event.type),
    ).not.toContain('task_run.cancelled');
    await expect(agent.newSession({ cwd: '/workspace' })).rejects.toThrow('shutting down');
  } finally {
    input.end();
    output.resume();
  }
});

describe('transport draining', () => {
  it('waits for requests queued before EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer({ input, output });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served: string[] = [];
    peer.handle('wait', async () => {
      await gate;
      served.push('done');
    });
    input.end('{"jsonrpc":"2.0","id":1,"method":"wait"}\n');
    release();
    await peer.drain();
    expect(served).toEqual(['done']);
    output.resume();
  });
});
