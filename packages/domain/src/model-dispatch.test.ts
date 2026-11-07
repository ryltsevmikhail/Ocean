import { describe, expect, it } from 'vitest';
import { decide } from '@runnets/domain';
import {
  apply,
  cmd,
  pending,
  running,
  settlement,
  startPayload,
} from '../test-fixtures/model-dispatch.js';

describe('model dispatch journal', () => {
  it('adopts first snapshot and charges actual usage exactly once', () => {
    const state = pending();
    expect(state.modelExecution?.startedRequests).toBe(1);
    const done = apply(state, 'SettleModelRequest', settlement());
    expect(done.events.map((e) => e.type)).toEqual([
      'attempt.model_request_settled',
      'attempt.usage_recorded',
    ]);
    expect(done.state.modelExecution?.usage.knownTokens).toBe(5);
    expect(done.state.budget.consumed.provider_tokens).toBe(5);
    expect(decide(done.state, cmd(done.state, 'SettleModelRequest', settlement())).ok).toBe(false);
    expect(
      decide(
        done.state,
        cmd(done.state, 'RecordUsage', { attemptId: 'at_test', usage: settlement().usage.tokens }),
      ).ok,
    ).toBe(false);
  });
  it('requires contiguous ordinals, frozen activation and matching attempt', () => {
    const state = running().state;
    for (const payload of [
      { ...startPayload(), ordinal: 2 },
      { ...startPayload(), attemptId: 'other' },
      { ...startPayload(), startedAt: '2026-01-01T00:10:00Z' },
    ]) {
      expect(decide(state, cmd(state, 'StartModelRequest', payload)).ok).toBe(false);
    }
    const done = apply(pending(), 'SettleModelRequest', settlement()).state;
    const next = { ...startPayload(2), startedAt: '2026-01-01T00:00:03Z' };
    expect(decide(done, cmd(done, 'StartModelRequest', next)).ok).toBe(true);
    expect(
      decide(
        done,
        cmd(done, 'StartModelRequest', {
          ...next,
          activation: {
            ...next.activation,
            limits: { ...next.activation.limits, maxModelRequests: 4 },
          },
        }),
      ).ok,
    ).toBe(false);
  });
  it('keeps unknown over-budget completion held in reconciliation', () => {
    const state = pending(2);
    const done = apply(state, 'SettleModelRequest', {
      ...settlement(),
      completion: { kind: 'unknown' },
    });
    expect(done.events.map((e) => e.type)).toEqual([
      'attempt.model_request_settled',
      'attempt.usage_recorded',
      'task_run.reconciling',
    ]);
    expect(done.state.status).toBe('reconciling');
    expect(done.state.budget.consumed.provider_tokens).toBe(5);
    expect(decide(done.state, cmd(done.state, 'ResolveReconcile', {})).ok).toBe(false);
  });
  it('records missing reported usage and permits failure but no success or retry', () => {
    const state = apply(pending(), 'SettleModelRequest', {
      ...settlement(),
      usage: { kind: 'unavailable', reason: 'not_reported' },
    }).state;
    expect(
      decide(state, cmd(state, 'Complete', { attemptId: 'at_test', summary: 'done' })).ok,
    ).toBe(false);
    expect(
      decide(
        state,
        cmd(state, 'Retry', { attemptId: 'at_test', delayMs: 0, dueAt: '2026-01-01T00:00:03Z' }),
      ).ok,
    ).toBe(false);
    expect(decide(state, cmd(state, 'StartModelRequest', startPayload(2))).ok).toBe(false);
    expect(
      decide(
        state,
        cmd(state, 'Fail', {
          attemptId: 'at_test',
          failure: { code: 'provider_error', message: 'missing usage' },
        }),
      ).ok,
    ).toBe(true);
  });
});
