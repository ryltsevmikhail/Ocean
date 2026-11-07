import { expect, it, vi } from 'vitest';
import { runTurn } from './turn.js';
import {
  activation,
  instant,
  provider,
  setup,
  terminal,
  usage,
} from '../test-fixtures/model-turn.js';
import type { ProviderEvent } from './provider.js';

const call = { type: 'tool_call', call: { id: 'one', name: 'read', arguments: '{}' } } as const;
const finishTools = {
  type: 'completed',
  stopReason: 'tool_calls',
  rawStopReason: 'tool_calls',
} as const;
const tools = {
  definitions: [{ name: 'read', description: 'read', parameters: {} }],
  execute: () => Promise.resolve({ output: 'read', isError: false }),
};

for (const [requested, expected] of [
  [undefined, 24],
  [100, 64],
  [2.9, 2],
  [-1, 1],
] as const) {
  it(`keeps the effective host request limit ${String(requested)} at ${expected}`, async () => {
    const input = await setup([call, usage, finishTools]);
    let calls = 0;
    const scripted = provider([call, usage, finishTools]);
    const result = await runTurn({
      ...input,
      ...(requested === undefined ? {} : { maxModelRequests: requested }),
      tools,
      provider: {
        ...scripted,
        stream(request) {
          calls++;
          return scripted.stream(request);
        },
      },
    });
    expect(result.stopReason).toBe('max_turn_requests');
    expect(calls).toBe(expected);
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      modelExecution: { startedRequests: expected },
    });
  });
}
it('refuses NaN host authority and malformed explicit limits before dispatch', async () => {
  for (const options of [
    { maxModelRequests: NaN },
    { activation: { ...activation(), limits: { ...activation().limits, turnTimeoutMs: 600001 } } },
    { activation: { ...activation(), limits: { ...activation().limits, maxModelRequests: 65 } } },
  ]) {
    const input = await setup();
    let calls = 0;
    const result = await runTurn({
      ...input,
      ...options,
      provider: {
        ...provider([]),
        stream() {
          calls++;
          throw Error('must not send');
        },
      },
    });
    expect(result.kind).toBe('failed');
    expect(calls).toBe(0);
  }
});
it('keeps connection metadata frozen across tool rounds without rereading provider capabilities', async () => {
  const input = await setup();
  const snapshot = {
    ...activation(),
    limits: { ...activation().limits },
    identity: {
      source: 'connection' as const,
      providerId: 'scripted',
      modelId: 'scripted',
      connectionId: 'local-one',
      connectionRevision: 3,
      botProfileVersion: 2,
      kind: 'local' as const,
      endpoint: 'http://localhost:1234/v1',
      auth: 'none' as const,
      artifactDigest: null,
      backendVersion: null,
    },
  };
  let calls = 0;
  const scripted = {
    ...provider([]),
    get capabilities() {
      if (calls > 0) throw Error('settings reread');
      return provider([]).capabilities;
    },
    async *stream(): AsyncIterable<ProviderEvent> {
      calls++;
      snapshot.limits.maxModelRequests = 1;
      snapshot.identity.connectionRevision = 99;
      if (calls === 1) {
        yield call;
        yield usage;
        yield finishTools;
      } else {
        yield usage;
        yield terminal;
      }
    },
  };
  expect((await runTurn({ ...input, activation: snapshot, tools, provider: scripted })).kind).toBe(
    'completed',
  );
  expect(calls).toBe(2);
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    modelExecution: {
      activation: { identity: { connectionRevision: 3 }, limits: { maxModelRequests: 24 } },
    },
  });
});
it('does not reset the turn deadline after a tool round', async () => {
  const input = await setup([call, usage, finishTools]);
  let current = Date.parse(instant),
    calls = 0;
  const scripted = provider([call, usage, finishTools]);
  const result = await runTurn({
    ...input,
    clock: { now: () => new Date(current) },
    activation: activation(),
    tools: {
      ...tools,
      execute() {
        current += 600000;
        return tools.execute();
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
  expect(result.kind).toBe('failed');
  expect(result.text).toContain('deadline');
  expect(calls).toBe(1);
});
it('bounds repeated late deltas against a fixed request timer', async () => {
  vi.useFakeTimers();
  try {
    const input = await setup();
    let entered!: () => void;
    const dispatched = new Promise<void>((r) => {
      entered = r;
    });
    let index = 0;
    const scripted = {
      ...provider([]),
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ProviderEvent>> {
                entered();
                await new Promise((r) => setTimeout(r, 4));
                index++;
                return { done: false, value: { type: 'text_delta', text: 'x' } };
              },
            };
          },
        };
      },
    };
    const snapshot = activation();
    const result = runTurn({
      ...input,
      activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
      provider: scripted,
    });
    await dispatched;
    await vi.advanceTimersByTimeAsync(11);
    expect((await result).kind).toBe('uncertain');
    expect(index).toBe(2);
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'reconciling',
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
    });
  } finally {
    vi.useRealTimers();
  }
});

it('refuses required tools when the adapter explicitly cannot dispatch them', async () => {
  const input = await setup();
  let calls = 0;
  const result = await runTurn({
    ...input,
    activation: activation(),
    tools,
    provider: {
      ...provider([]),
      capabilities: { ...provider([]).capabilities, toolCalls: false },
      stream() {
        calls++;
        throw Error('must not send');
      },
    },
  });
  expect(result.kind).toBe('failed');
  expect(calls).toBe(0);
});
