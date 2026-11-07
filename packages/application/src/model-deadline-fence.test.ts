import { expect, it, vi } from 'vitest';
import { ProviderError, type ProviderEvent } from './provider.js';
import { runTurn } from './turn.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

for (const late of ['usage', 'terminal', 'done', 'throw'] as const) {
  it(`rejects ${late} when the fixed timer is overdue before its callback runs`, async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const input = await setup();
      let effects = 0;
      const emitted: unknown[] = [];
      const scripted = {
        ...provider([]),
        async *stream(): AsyncIterable<ProviderEvent> {
          if (late === 'usage' || late === 'throw') elapsed = 11;
          if (late === 'throw')
            throw new ProviderError('network', 'late nonexecution claim', { dispatch: 'not_sent' });
          yield usage;
          if (late === 'terminal') elapsed = 11;
          yield terminal;
          if (late === 'done') elapsed = 11;
        },
      };
      const snapshot = activation();
      const result = await runTurn({
        ...input,
        provider: scripted,
        emit: (u) => emitted.push(u),
        activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
        tools: {
          definitions: [{ name: 'write', description: 'write', parameters: {} }],
          execute() {
            effects++;
            return Promise.resolve({ output: 'write', isError: false });
          },
        },
      });
      expect(result.kind).toBe('uncertain');
      expect(effects).toBe(0);
      expect(await input.service.state(input.taskRunId)).toMatchObject({
        status: 'reconciling',
        modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
        budget: { consumed: { provider_tokens: late === 'usage' || late === 'throw' ? 0 : 2 } },
      });
      const events = await input.service.events(input.taskRunId);
      const count = emitted.length;
      await vi.runAllTimersAsync();
      expect(await input.service.events(input.taskRunId)).toEqual(events);
      expect(emitted).toHaveLength(count);
      expect(events.filter((e) => e.type === 'attempt.model_request_settled')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
}

it('yields during repeated ready events so an owner timer can propagate before terminal framing', async () => {
  vi.useFakeTimers();
  try {
    const input = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scripted = {
      ...provider([]),
      async *stream(): AsyncIterable<ProviderEvent> {
        entered();
        for (let n = 0; n < 100; n++) yield { type: 'text_delta', text: 'x' };
        yield usage;
        yield terminal;
      },
    };
    const snapshot = activation();
    const result = runTurn({
      ...input,
      provider: scripted,
      signal: controller.signal,
      activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
    });
    await dispatched;
    setTimeout(() => controller.abort(), 0);
    await vi.runAllTimersAsync();
    expect((await result).kind).toBe('cancelled');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'cancelled',
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'terminal' } } } },
    });
  } finally {
    vi.useRealTimers();
  }
});
