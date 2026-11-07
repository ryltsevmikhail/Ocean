import { expect, it, vi } from 'vitest';
import { runTurn } from './turn.js';
import type { ModelRequest, ProviderEvent } from './provider.js';
import { activation, provider, setup, terminal, usage } from '../test-fixtures/model-turn.js';

it('collects valid terminal framing after owner abort within the original deadline before confirming cleanup', async () => {
  vi.useFakeTimers();
  try {
    const input = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const dispatched = new Promise<void>((r) => {
      entered = r;
    });
    const scripted = {
      ...provider([]),
      async *stream() {
        entered();
        await new Promise((r) => setTimeout(r, 4));
        yield usage;
        yield terminal;
      },
    };
    const snapshot = activation();
    const result = runTurn({
      ...input,
      signal: controller.signal,
      activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
      provider: scripted,
    });
    await dispatched;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5);
    expect((await result).kind).toBe('cancelled');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'cancelled',
      budget: { consumed: { provider_tokens: 2 } },
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'terminal' } } } },
    });
  } finally {
    vi.useRealTimers();
  }
});
it('bounds an owner-aborted next that ignores the signal without claiming cleanup', async () => {
  vi.useFakeTimers();
  try {
    const input = await setup();
    const controller = new AbortController();
    let entered!: () => void;
    const dispatched = new Promise<void>((r) => {
      entered = r;
    });
    let forwarded: AbortSignal | undefined;
    const scripted = {
      ...provider([]),
      stream(request: ModelRequest) {
        forwarded = request.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                entered();
                return new Promise<IteratorResult<ProviderEvent>>(() => {});
              },
              return() {
                return new Promise<IteratorResult<ProviderEvent>>(() => {});
              },
            };
          },
        };
      },
    };
    const snapshot = activation();
    let returned = false;
    const result = runTurn({
      ...input,
      signal: controller.signal,
      activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
      provider: scripted,
    }).then((r) => {
      returned = true;
      return r;
    });
    await dispatched;
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(9);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await result).kind).toBe('uncertain');
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'cancelling',
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
    });
    const events = await input.service.events(input.taskRunId);
    expect(events.some((e) => e.type === 'task_run.cancelled')).toBe(false);
    expect(events.filter((e) => e.type === 'attempt.model_request_settled')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
