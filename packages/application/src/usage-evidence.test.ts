import { expect, it } from 'vitest';
import { unlimitedBudget } from '@runnets/domain';
import { runTurn } from './turn.js';
import { collectReply, ProviderError } from './provider.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

for (const capability of ['reported', 'optional', 'unavailable'] as const) {
  it(`keeps missing ${capability} usage distinct from zero`, async () => {
    const input = await setup([terminal]);
    const outcome = await runTurn({ ...input, activation: activation(capability) });
    expect(outcome.kind).toBe(capability === 'reported' ? 'failed' : 'completed');
    const state = await input.service.state(input.taskRunId);
    expect(state).toMatchObject({
      modelExecution: {
        usage: { knownTokens: 0, unavailableRequests: 1 },
        lastRequest: {
          settlement: {
            completion: { kind: 'terminal' },
            usage: {
              kind: 'unavailable',
              reason: capability === 'unavailable' ? 'unsupported' : 'not_reported',
            },
          },
        },
      },
    });
    expect(
      (await input.service.events(input.taskRunId)).filter(
        (e) => e.type === 'attempt.usage_recorded',
      ),
    ).toHaveLength(0);
  });
}
it('charges actual zero once and does not use the legacy charging command', async () => {
  const input = await setup([
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    terminal,
  ]);
  expect((await runTurn(input)).kind).toBe('completed');
  const events = await input.service.events(input.taskRunId);
  const charges = events.filter((e) => e.type === 'attempt.usage_recorded');
  expect(charges).toHaveLength(1);
  expect(charges[0]?.causationId).toMatch(/_model_.*_settle$/);
});
for (const capability of ['optional', 'unavailable'] as const) {
  it(`rejects finite exact token budgets with ${capability} metrics before network`, async () => {
    const input = await setup([], { ...unlimitedBudget(), provider_tokens: 100 });
    let calls = 0;
    const outcome = await runTurn({
      ...input,
      activation: activation(capability),
      provider: {
        ...provider([]),
        stream() {
          calls++;
          throw Error('must not send');
        },
      },
    });
    expect(outcome.kind).toBe('failed');
    expect(calls).toBe(0);
    expect((await input.service.events(input.taskRunId)).map((e) => e.type)).not.toContain(
      'attempt.model_request_started',
    );
  });
}
it('records actual accounting but holds an interrupted overbudget response', async () => {
  const input = await setup(
    [usage, { type: 'error', error: new ProviderError('server', 'response lost') }],
    { ...unlimitedBudget(), provider_tokens: 1 },
  );
  expect((await runTurn(input)).kind).toBe('uncertain');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    budget: { consumed: { provider_tokens: 2 } },
    modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
  });
});
it('retains explicit usage evidence in collectReply without inventing exact usage', async () => {
  const reply = await collectReply(
    provider([
      { type: 'usage_evidence', evidence: { kind: 'unavailable', reason: 'unsupported' } },
      terminal,
    ]).stream({ model: 'scripted', messages: [] }),
  );
  expect(reply.usage).toBeNull();
  expect(reply.usageEvidence).toEqual({ kind: 'unavailable', reason: 'unsupported' });
});

for (const dispatch of ['not_sent', 'rejected', 'unknown'] as const) {
  it(`honors explicit ${dispatch} error evidence without classifying by error code`, async () => {
    const input = await setup([
      { type: 'error', error: new ProviderError('server', 'scripted evidence', { dispatch }) },
    ]);
    const result = await runTurn(input);
    expect(result.kind).toBe(dispatch === 'unknown' ? 'uncertain' : 'failed');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: dispatch === 'unknown' ? 'reconciling' : 'failed',
      modelExecution: { lastRequest: { settlement: { completion: { kind: dispatch } } } },
    });
  });
}
for (const events of [
  [terminal, terminal],
  [usage],
  [terminal, { type: 'text_delta', text: 'after finish' } as const],
]) {
  it('requires complete single-terminal framing before success or tools', async () => {
    const input = await setup(events);
    expect((await runTurn(input)).kind).toBe('uncertain');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'reconciling',
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
    });
    expect(
      (await input.service.events(input.taskRunId)).filter(
        (e) => e.type === 'task_run.reconciling',
      ),
    ).toHaveLength(1);
  });
}
it('retains explicit actual and estimated evidence through both reply collectors', async () => {
  for (const kind of ['actual', 'estimated'] as const) {
    const evidence =
      kind === 'actual'
        ? { kind, tokens: usage.usage }
        : { kind, tokens: usage.usage, estimator: 'test-only' };
    const input = await setup([{ type: 'usage_evidence', evidence }, terminal]);
    const port = input.provider!;
    const reply = await collectReply(port.stream({ model: 'scripted', messages: [] }));
    expect(reply.usageEvidence).toEqual(evidence);
    expect(reply.usage).toEqual(kind === 'actual' ? usage.usage : null);
    expect((await runTurn({ ...input, activation: activation('optional') })).kind).toBe(
      'completed',
    );
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      modelExecution: { lastRequest: { settlement: { usage: evidence } } },
    });
  }
});

it('keeps contradictory nonexecution evidence after partial inference unknown', async () => {
  const input = await setup([
    { type: 'text_delta', text: 'partial inference' },
    {
      type: 'error',
      error: new ProviderError('auth', 'contradictory refusal', { dispatch: 'not_sent' }),
    },
  ]);
  expect((await runTurn(input)).kind).toBe('uncertain');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
  });
});
it('keeps a provider error after a claimed terminal unknown even if annotated not_sent', async () => {
  const input = await setup();
  const scripted = {
    ...provider([]),
    async *stream() {
      yield usage;
      yield terminal;
      throw new ProviderError('network', 'lost trailer', { dispatch: 'not_sent' });
    },
  };
  expect((await runTurn({ ...input, provider: scripted })).kind).toBe('uncertain');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
  });
});
