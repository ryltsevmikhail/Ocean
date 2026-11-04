import { expect, it } from 'vitest';
import { ProviderError, type ProviderEvent, type ModelRequest } from './provider.js';
import { runTurn } from './turn.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

for (const broken of [true, false]) {
  it(`does not admit tool effects without usable terminal evidence (broken=${broken})`, async () => {
    const events: ProviderEvent[] = [
      { type: 'tool_call', call: { id: 'one', name: 'write', arguments: '{}' } },
      ...(broken ? [usage] : []),
      ...(broken
        ? [{ type: 'error' as const, error: new ProviderError('server', 'stream lost') }]
        : [{ ...terminal, stopReason: 'tool_calls' as const }]),
    ];
    const input = await setup(events);
    let calls = 0,
      effects = 0;
    const scripted = input.provider!;
    const result = await runTurn({
      ...input,
      tools: {
        definitions: [{ name: 'write', description: 'write', parameters: {} }],
        execute() {
          effects++;
          return Promise.resolve({ output: 'written', isError: false });
        },
      },
      provider: {
        ...scripted,
        stream(request) {
          calls++;
          return scripted.stream(request);
        },
      },
    });
    expect(result.kind).toBe(broken ? 'uncertain' : 'failed');
    expect(calls).toBe(1);
    expect(effects).toBe(0);
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      modelExecution: {
        lastRequest: { settlement: { completion: { kind: broken ? 'unknown' : 'terminal' } } },
      },
    });
  });
}
it('never selects a cloud port after a local-model failure', async () => {
  const input = await setup();
  let localCalls = 0,
    cloudCalls = 0;
  const cloud = {
    ...provider([usage, terminal]),
    stream(request: ModelRequest) {
      cloudCalls++;
      return provider([usage, terminal]).stream(request);
    },
  };
  // Selection occurs in the host; the engine receives exactly the selected port.
  const ports = {
    cloud,
    local: {
      ...provider([]),
      stream() {
        localCalls++;
        throw new ProviderError('network', 'local endpoint unavailable');
      },
    },
  };
  const snapshot = activation();
  const result = await runTurn({
    ...input,
    activation: {
      ...snapshot,
      identity: {
        source: 'connection',
        providerId: 'scripted',
        modelId: 'scripted',
        connectionId: 'local',
        connectionRevision: 1,
        botProfileVersion: 1,
        kind: 'local',
        endpoint: 'http://localhost:1234/v1',
        auth: 'none',
        artifactDigest: null,
        backendVersion: null,
      },
    },
    provider: ports.local,
  });
  expect(result.kind).toBe('uncertain');
  expect(localCalls).toBe(1);
  expect(cloudCalls).toBe(0);
});
