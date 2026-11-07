import { expect, it } from 'vitest';
import { runTurn } from './turn.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

const tools = {
  definitions: [{ name: 'read', description: 'read', parameters: {} }],
  execute: () => Promise.resolve({ output: 'read', isError: false }),
};
for (const [source, snapshotTools, portTools, allowed] of [
  ['connection', true, undefined, true],
  ['connection', true, false, false],
  ['connection', false, true, false],
  ['host', true, undefined, false],
] as const) {
  it(`checks required tools for ${source} snapshot=${snapshotTools} adapter=${String(portTools)}`, async () => {
    const input = await setup();
    const snapshot = activation();
    const connection = {
      ...snapshot,
      identity: {
        source: 'connection' as const,
        providerId: 'scripted',
        modelId: 'scripted',
        connectionId: 'one',
        connectionRevision: 1,
        botProfileVersion: 1,
        kind: 'cloud' as const,
        endpoint: 'https://example.invalid',
        auth: 'api_key' as const,
        artifactDigest: null,
        backendVersion: null,
      },
      capabilities: { ...snapshot.capabilities, tools: snapshotTools },
    };
    let calls = 0;
    const capabilities = {
      streaming: true,
      usage: true,
      reasoning: false,
      ...(portTools === undefined ? {} : { toolCalls: portTools }),
    };
    const scripted = provider([usage, terminal]);
    const result = await runTurn({
      ...input,
      ...(source === 'host' ? {} : { activation: connection }),
      tools,
      provider: {
        ...scripted,
        capabilities,
        stream(request) {
          calls++;
          return scripted.stream(request);
        },
      },
    });
    expect(calls).toBe(allowed ? 1 : 0);
    expect(result.kind).toBe(allowed ? 'completed' : 'failed');
  });
}

it('refuses streaming when explicit activation contradicts an incapable adapter', async () => {
  const input = await setup();
  const scripted = provider([usage, terminal]);
  let calls = 0;
  const result = await runTurn({
    ...input,
    activation: activation(),
    provider: {
      ...scripted,
      capabilities: { ...scripted.capabilities, streaming: false },
      stream(request) {
        calls++;
        return scripted.stream(request);
      },
    },
  });
  expect(result.kind).toBe('failed');
  expect(calls).toBe(0);
});
