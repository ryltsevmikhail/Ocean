import { expect, it } from 'vitest';
import {
  collectReply,
  ProviderError,
  type ModelUsageEvidence,
  type ProviderEvent,
} from './provider.js';
import { runTurn } from './turn.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

for (const weaker of [
  { kind: 'unavailable', reason: 'not_reported' },
  {
    kind: 'estimated',
    tokens: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
    estimator: 'fixture',
  },
] as const) {
  for (const capability of ['reported', 'optional'] as const) {
    it(`preserves actual debit before ${weaker.kind} with ${capability} usage`, async () => {
      const events: ProviderEvent[] = [
        usage,
        { type: 'usage_evidence', evidence: weaker },
        terminal,
      ];
      const input = await setup(events);
      const reply = await collectReply(
        provider(events).stream({ model: 'scripted', messages: [] }),
      );
      expect(reply.usage).toEqual(usage.usage);
      expect(reply.usageEvidence).toEqual({ kind: 'actual', tokens: usage.usage });
      expect(reply.error).toBeNull();
      expect((await runTurn({ ...input, activation: activation(capability) })).kind).toBe(
        'completed',
      );
      expect(await input.service.state(input.taskRunId)).toMatchObject({
        budget: { consumed: { provider_tokens: 2 } },
        modelExecution: {
          lastRequest: { settlement: { usage: { kind: 'actual', tokens: usage.usage } } },
        },
      });
      expect(
        (await input.service.events(input.taskRunId)).filter(
          (e) => e.type === 'attempt.usage_recorded',
        ),
      ).toHaveLength(1);
    });
  }
}
const higher = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
for (const [label, first, second, retained, conflict] of [
  ['equal duplicate', usage.usage, usage.usage, usage.usage, false],
  ['nondecreasing cumulative', usage.usage, higher, higher, false],
  ['decreasing', higher, usage.usage, higher, true],
  [
    'crossed higher total',
    { inputTokens: 3, outputTokens: 0, totalTokens: 3 },
    { inputTokens: 1, outputTokens: 4, totalTokens: 5 },
    { inputTokens: 1, outputTokens: 4, totalTokens: 5 },
    true,
  ],
  [
    'crossed tied total',
    usage.usage,
    { inputTokens: 0, outputTokens: 2, totalTokens: 2 },
    usage.usage,
    true,
  ],
] as const) {
  it(`handles ${label} actual reports identically in both collectors without summing`, async () => {
    const events: ProviderEvent[] = [
      { type: 'usage', usage: first },
      { type: 'usage_evidence', evidence: { kind: 'actual', tokens: second } },
      terminal,
    ];
    const reply = await collectReply(provider(events).stream({ model: 'scripted', messages: [] }));
    expect(reply.usage).toEqual(retained);
    expect(reply.usageEvidence).toEqual({ kind: 'actual', tokens: retained });
    expect(reply.error !== null).toBe(conflict);
    const input = await setup(events);
    expect((await runTurn(input)).kind).toBe(conflict ? 'uncertain' : 'completed');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: conflict ? 'reconciling' : 'succeeded',
      budget: { consumed: { provider_tokens: retained.totalTokens } },
      modelExecution: {
        lastRequest: {
          settlement: {
            completion: { kind: conflict ? 'unknown' : 'terminal' },
            usage: { kind: 'actual', tokens: retained },
          },
        },
      },
    });
    expect(
      (await input.service.events(input.taskRunId)).filter(
        (e) => e.type === 'attempt.usage_recorded',
      ),
    ).toHaveLength(1);
  });
}
it('latches a crossed-report conflict even if a later cumulative report becomes consistent', async () => {
  const evidence: ModelUsageEvidence = {
    kind: 'actual',
    tokens: { inputTokens: 0, outputTokens: 2, totalTokens: 2 },
  };
  const events: ProviderEvent[] = [
    usage,
    { type: 'usage_evidence', evidence },
    { type: 'usage', usage: higher },
    { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'interrupted' } },
    terminal,
  ];
  const reply = await collectReply(provider(events).stream({ model: 'scripted', messages: [] }));
  expect(reply.usage).toEqual(higher);
  expect(reply.error).not.toBeNull();
  const input = await setup(events);
  expect((await runTurn(input)).kind).toBe('uncertain');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    budget: { consumed: { provider_tokens: 5 } },
  });
});

it('keeps estimated evidence ahead of a later unavailable observation without an exact debit', async () => {
  const evidence: ModelUsageEvidence = { kind: 'estimated', tokens: higher, estimator: 'fixture' };
  const events: ProviderEvent[] = [
    { type: 'usage_evidence', evidence },
    { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'not_reported' } },
    terminal,
  ];
  const reply = await collectReply(provider(events).stream({ model: 'scripted', messages: [] }));
  expect(reply.usageEvidence).toEqual(evidence);
  expect(reply.usage).toBeNull();
  const input = await setup(events);
  expect((await runTurn({ ...input, activation: activation('optional') })).kind).toBe('completed');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    budget: { consumed: { provider_tokens: 0 } },
    modelExecution: { usage: { estimatedTokens: 5 } },
  });
});
it('does not treat a genuine actual zero as positive inference evidence', async () => {
  const input = await setup([
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    {
      type: 'error',
      error: new ProviderError('network', 'known pre-send refusal', { dispatch: 'not_sent' }),
    },
  ]);
  expect((await runTurn(input)).kind).toBe('failed');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'failed',
    modelExecution: {
      lastRequest: {
        settlement: {
          completion: { kind: 'not_sent' },
          usage: { kind: 'actual', tokens: { totalTokens: 0 } },
        },
      },
    },
  });
});

it('keeps conflicting actual reports from admitting tools or another model request', async () => {
  const input = await setup();
  let calls = 0,
    effects = 0;
  const scripted = {
    ...provider([]),
    async *stream(): AsyncIterable<ProviderEvent> {
      calls++;
      yield { type: 'usage', usage: higher };
      yield usage;
      yield { type: 'tool_call', call: { id: 'one', name: 'write', arguments: '{}' } };
      yield { ...terminal, stopReason: 'tool_calls' };
    },
  };
  expect(
    (
      await runTurn({
        ...input,
        provider: scripted,
        tools: {
          definitions: [{ name: 'write', description: 'write', parameters: {} }],
          execute() {
            effects++;
            return Promise.resolve({ output: 'write', isError: false });
          },
        },
      })
    ).kind,
  ).toBe('uncertain');
  expect(calls).toBe(1);
  expect(effects).toBe(0);
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    budget: { consumed: { provider_tokens: 5 } },
    status: 'reconciling',
  });
});

for (const invalid of [NaN, Infinity, 1.5]) {
  it(`retains valid actual debit when a subsequent actual count is invalid (${String(invalid)})`, async () => {
    const events: ProviderEvent[] = [
      { type: 'usage', usage: higher },
      { type: 'usage', usage: { inputTokens: invalid, outputTokens: 3, totalTokens: 8 } },
      terminal,
    ];
    const reply = await collectReply(provider(events).stream({ model: 'scripted', messages: [] }));
    expect(reply.usage).toEqual(higher);
    expect(reply.error).not.toBeNull();
    const input = await setup(events);
    expect((await runTurn(input)).kind).toBe('uncertain');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'reconciling',
      budget: { consumed: { provider_tokens: 5 } },
      modelExecution: {
        lastRequest: {
          settlement: {
            completion: { kind: 'unknown' },
            usage: { kind: 'actual', tokens: higher },
          },
        },
      },
    });
  });
}
