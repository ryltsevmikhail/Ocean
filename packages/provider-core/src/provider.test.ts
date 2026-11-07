import { describe, expect, it } from 'vitest';

import {
  ProviderError,
  collectReply,
  type ProviderErrorCode,
  type ProviderEvent,
  type TokenUsage,
} from './provider.js';

async function* eventsOf(values: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
  for (const value of values) yield value;
}

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

describe('ProviderError', () => {
  const defaults: ReadonlyArray<[ProviderErrorCode, boolean]> = [
    ['auth', false],
    ['rate_limit', true],
    ['timeout', true],
    ['network', true],
    ['server', true],
    ['invalid_request', false],
    ['cancelled', false],
    ['unknown', false],
  ];

  it.each(defaults)('classifies %s as retryable=%s by default', (code, retryable) => {
    const error = new ProviderError(code, 'failure');
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBeNull();
    expect(error.name).toBe('ProviderError');
  });

  it('honours an explicit retryable flag and status', () => {
    const error = new ProviderError('server', 'failure', { retryable: false, status: 503 });
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(503);
  });
});

describe('collectReply', () => {
  it('accumulates text, reasoning, usage and stop reason', async () => {
    const deltas: string[] = [];
    const reply = await collectReply(
      eventsOf([
        { type: 'reasoning_delta', text: 'thinking' },
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'usage', usage: USAGE },
        { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
      ]),
      (text) => deltas.push(text),
    );

    expect(reply.text).toBe('Hello world');
    expect(reply.reasoning).toBe('thinking');
    expect(reply.usage).toEqual(USAGE);
    expect(reply.stopReason).toBe('stop');
    expect(reply.error).toBeNull();
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('returns the provider error and leaves usage unset', async () => {
    const error = new ProviderError('rate_limit', 'slow down');
    const reply = await collectReply(eventsOf([{ type: 'error', error }]));

    expect(reply.error).toBe(error);
    expect(reply.usage).toBeNull();
    expect(reply.stopReason).toBeNull();
  });

  it('returns nulls for an empty stream', async () => {
    const reply = await collectReply(eventsOf([]));

    expect(reply).toEqual({
      text: '',
      reasoning: '',
      usage: null,
      usageEvidence: null,
      stopReason: null,
      error: null,
    });
  });
});

for (const weaker of [
  { kind: 'unavailable', reason: 'not_reported' },
  {
    kind: 'estimated',
    tokens: { inputTokens: 20, outputTokens: 20, totalTokens: 40 },
    estimator: 'fixture',
  },
] as const) {
  it(`conserves actual usage before ${weaker.kind} through the public provider collector`, async () => {
    const reply = await collectReply(
      eventsOf([
        { type: 'usage', usage: USAGE },
        { type: 'usage_evidence', evidence: weaker },
      ]),
    );
    expect(reply.usage).toEqual(USAGE);
    expect(reply.usageEvidence).toEqual({ kind: 'actual', tokens: USAGE });
    expect(reply.error).toBeNull();
  });
}
for (const dispatch of ['not_sent', 'rejected'] as const) {
  it(`retains actual usage and surfaces contradictory ${dispatch} as unknown in collectReply`, async () => {
    const reply = await collectReply(
      eventsOf([
        { type: 'usage', usage: USAGE },
        { type: 'error', error: new ProviderError('network', 'contradiction', { dispatch }) },
      ]),
    );
    expect(reply.usage).toEqual(USAGE);
    expect(reply.error?.dispatch).toBe('unknown');
  });
}
