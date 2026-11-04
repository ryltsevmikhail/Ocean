import { describe, expect, it } from 'vitest';
import { ABSENT, decide, evolve, replay, type TaskRunState } from '@runnets/domain';
import {
  activation,
  apply,
  cmd,
  pending,
  running,
  settlement,
  startPayload,
} from '../test-fixtures/model-dispatch.js';

describe('model accounting and prefix replay', () => {
  it('preserves old bytes and seeds exact usage from the existing ledger', () => {
    const initial = running();
    const legacy = apply(initial.state, 'RecordUsage', {
      attemptId: 'at_test',
      usage: settlement().usage.tokens,
    });
    const old = [...initial.history, ...legacy.events],
      bytes = JSON.stringify(old);
    expect((replay(old) as TaskRunState).modelExecution).toBe(null);
    const started = apply(legacy.state, 'StartModelRequest', startPayload());
    expect(started.state.modelExecution?.usage.knownTokens).toBe(5);
    const settled = apply(started.state, 'SettleModelRequest', settlement());
    const history = [...old, ...started.events, ...settled.events];
    for (let index = 0; index <= history.length; index++) {
      const checkpoint = JSON.parse(JSON.stringify(history.slice(0, index))) as typeof history;
      const restored = history.slice(index).reduce(evolve, replay(checkpoint));
      expect(restored).toEqual(settled.state);
    }
    const prefix = replay(history.slice(0, -1)) as TaskRunState;
    expect(prefix.modelExecution?.lastRequest.settlement).not.toBe(null);
    expect(prefix.modelExecution?.usage.knownTokens).toBe(5);
    expect(prefix.budget.consumed.provider_tokens).toBe(5);
    expect(settled.state.modelExecution?.usage.knownTokens).toBe(10);
    expect(settled.state.budget.consumed.provider_tokens).toBe(10);
    expect(JSON.stringify(old)).toBe(bytes);
    expect(replay([])).toEqual(ABSENT);
  });
  it('replays every unknown over-budget prefix into the same held state', () => {
    const initial = running(2),
      start = apply(initial.state, 'StartModelRequest', startPayload());
    const done = apply(start.state, 'SettleModelRequest', {
      ...settlement(),
      completion: { kind: 'unknown' },
    });
    const history = [...initial.history, ...start.events, ...done.events];
    for (let i = 0; i <= history.length; i++)
      expect(history.slice(i).reduce(evolve, replay(history.slice(0, i)))).toEqual(done.state);
    expect(done.state.status).toBe('reconciling');
    expect(done.state.modelExecution?.usage.knownTokens).toBe(5);
  });
  it('retains known exhaustion threshold and refuses starts at exact capacity or reservations', () => {
    const exhausted = apply(pending(2), 'SettleModelRequest', settlement());
    expect(exhausted.events.map((e) => e.type)).toEqual([
      'attempt.model_request_settled',
      'attempt.usage_recorded',
      'task_run.budget_exhausted',
    ]);
    expect(exhausted.state.status).toBe('budget_exhausted');
    const equal = apply(pending(5), 'SettleModelRequest', settlement()).state;
    expect(equal.status).toBe('running');
    expect(
      decide(
        equal,
        cmd(equal, 'StartModelRequest', { ...startPayload(2), startedAt: '2026-01-01T00:00:03Z' }),
      ).ok,
    ).toBe(false);
    for (const limit of [0, 5]) {
      const state = running(limit).state;
      const reserved = {
        ...state,
        budget: { ...state.budget, reserved: { ...state.budget.reserved, provider_tokens: limit } },
      };
      expect(decide(reserved, cmd(reserved, 'StartModelRequest', startPayload())).ok).toBe(false);
    }
  });
  it.each(['optional', 'unavailable'] as const)(
    'allows %s usage only without finite exact budget',
    (usage) => {
      const payload = {
        ...startPayload(),
        activation: { ...activation(), capabilities: { ...activation().capabilities, usage } },
      };
      const finite = running(10).state;
      expect(decide(finite, cmd(finite, 'StartModelRequest', payload)).ok).toBe(false);
      const start = apply(running().state, 'StartModelRequest', payload).state;
      const done = apply(start, 'SettleModelRequest', {
        ...settlement(),
        usage: { kind: 'unavailable', reason: 'unsupported' },
      }).state;
      expect(done.modelExecution?.usage).toEqual({
        knownTokens: 0,
        estimatedTokens: 0,
        unavailableRequests: 1,
      });
      expect(done.budget.consumed.provider_tokens).toBe(0);
      expect(
        decide(done, cmd(done, 'Complete', { attemptId: 'at_test', summary: 'done' })).ok,
      ).toBe(true);
    },
  );
  it('keeps estimates separate and enforces turn-wide request cap', () => {
    const payload = {
      ...startPayload(),
      activation: {
        ...activation(),
        capabilities: { ...activation().capabilities, usage: 'optional' as const },
        limits: { ...activation().limits, maxModelRequests: 1 },
      },
    };
    const state = apply(running().state, 'StartModelRequest', payload).state;
    const done = apply(state, 'SettleModelRequest', {
      ...settlement(),
      usage: { kind: 'estimated', estimator: 'fixture', tokens: settlement().usage.tokens },
    });
    expect(done.events.map((e) => e.type)).toEqual(['attempt.model_request_settled']);
    expect(done.state.modelExecution?.usage).toEqual({
      knownTokens: 0,
      estimatedTokens: 5,
      unavailableRequests: 0,
    });
    expect(done.state.budget.consumed.provider_tokens).toBe(0);
    expect(
      decide(
        done.state,
        cmd(done.state, 'StartModelRequest', {
          ...payload,
          ordinal: 2,
          startedAt: '2026-01-01T00:00:03Z',
        }),
      ).ok,
    ).toBe(false);
  });
  it('rejects unsafe cumulative accounting and unsafe legacy seed', () => {
    const state = pending();
    const full = {
      ...state,
      budget: {
        ...state.budget,
        consumed: { ...state.budget.consumed, provider_tokens: Number.MAX_SAFE_INTEGER },
      },
    };
    expect(decide(full, cmd(full, 'SettleModelRequest', settlement())).ok).toBe(false);
    if (state.modelExecution === null) throw new Error('missing execution');
    for (const usage of [
      { kind: 'estimated' as const, estimator: 'test', tokens: settlement().usage.tokens },
      { kind: 'unavailable' as const, reason: 'unsupported' as const },
    ]) {
      const summary = {
        ...state,
        modelExecution: {
          ...state.modelExecution,
          usage: {
            knownTokens: 0,
            estimatedTokens: Number.MAX_SAFE_INTEGER,
            unavailableRequests: Number.MAX_SAFE_INTEGER,
          },
        },
      };
      expect(
        decide(summary, cmd(summary, 'SettleModelRequest', { ...settlement(), usage })).ok,
      ).toBe(false);
    }
    const legacy = {
      ...running().state,
      budget: {
        ...full.budget,
        consumed: { ...full.budget.consumed, provider_tokens: Number.MAX_SAFE_INTEGER + 1 },
      },
    };
    expect(decide(legacy, cmd(legacy, 'StartModelRequest', startPayload())).ok).toBe(false);
  });
});
