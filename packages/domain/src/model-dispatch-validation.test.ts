import { describe, expect, it } from 'vitest';
import {
  decide,
  type ModelActivationSnapshot,
  type StartModelRequestPayload,
  type SettleModelRequestPayload,
} from '@runnets/domain';
import {
  activation,
  apply,
  cmd,
  pending,
  running,
  settlement,
  startPayload,
} from '../test-fixtures/model-dispatch.js';

function acceptsStart(value: unknown): boolean {
  const state = running().state;
  return decide(state, cmd(state, 'StartModelRequest', value as StartModelRequestPayload)).ok;
}
describe('strict model evidence validation', () => {
  it('rejects malformed payloads without coercion', () => {
    for (const payload of [
      null,
      {},
      { ...startPayload(), ordinal: '1' },
      { ...startPayload(), ordinal: NaN },
      { ...startPayload(), ordinal: Number.MAX_SAFE_INTEGER + 1 },
      { ...startPayload(), attemptId: 1 },
      { ...startPayload(), activation: null },
    ])
      expect(acceptsStart(payload)).toBe(false);
  });
  it('rejects impossible UTC calendar times and ordering', () => {
    for (const startedAt of [
      '2026-02-30T00:00:01Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:00:00.1234Z',
      '2026-01-01T00:00:01+00:00',
      '2025-12-31T23:59:59Z',
      '2026-01-01T00:10:00Z',
    ]) {
      expect(acceptsStart({ ...startPayload(), startedAt })).toBe(false);
    }
    for (const startedAt of [
      '2026-01-01T00:00:01Z',
      '2026-01-01T00:00:01.1Z',
      '2026-01-01T00:00:01.12Z',
      '2026-01-01T00:00:01.123Z',
    ]) {
      expect(acceptsStart({ ...startPayload(), startedAt })).toBe(true);
    }
    for (const patch of [
      { admittedAt: '2026-01-01T00:10:00Z' },
      { deadlineAt: '2026-01-01T00:10:01Z' },
      { admittedAt: '2026-02-30T00:00:00Z' },
    ]) {
      expect(acceptsStart({ ...startPayload(), activation: { ...activation(), ...patch } })).toBe(
        false,
      );
    }
  });
  it('validates all frozen limits and capability shapes', () => {
    for (const key of ['maxModelRequests', 'requestTimeoutMs', 'turnTimeoutMs'] as const) {
      for (const value of [
        0,
        -1,
        0.5,
        '3',
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        key === 'maxModelRequests' ? 65 : 600001,
      ]) {
        expect(
          acceptsStart({
            ...startPayload(),
            activation: { ...activation(), limits: { ...activation().limits, [key]: value } },
          }),
        ).toBe(false);
      }
    }
    for (const patch of [
      { tools: 1 },
      { streaming: null },
      { inputModalities: ['audio'] },
      { inputModalities: null },
      { contextTokens: -1 },
      { maxOutputTokens: 0.5 },
      { contextTokens: Number.MAX_SAFE_INTEGER + 1 },
      { usage: 'maybe' },
    ]) {
      expect(
        acceptsStart({
          ...startPayload(),
          activation: { ...activation(), capabilities: { ...activation().capabilities, ...patch } },
        }),
      ).toBe(false);
    }
  });
  it('accepts legacy connection revision zero and validates complete identity', () => {
    const identity = {
      source: 'connection' as const,
      providerId: 'test',
      modelId: 'test',
      connectionId: 'connection',
      connectionRevision: 0,
      botProfileVersion: 1,
      kind: 'cloud' as const,
      endpoint: 'https://test.invalid',
      auth: 'api_key' as const,
      artifactDigest: null,
      backendVersion: null,
    };
    const payload = { ...startPayload(), activation: { ...activation(), identity } };
    expect(acceptsStart(payload)).toBe(true);
    for (const patch of [
      { connectionRevision: -1 },
      { connectionRevision: 1.5 },
      { botProfileVersion: 0 },
      { connectionId: '' },
      { providerId: 'other' },
      { modelId: 'other' },
      { endpoint: null },
      { kind: 'other' },
      { auth: 'other' },
      { artifactDigest: 5 },
      { backendVersion: undefined },
    ]) {
      expect(
        acceptsStart({
          ...payload,
          activation: { ...payload.activation, identity: { ...identity, ...patch } },
        }),
      ).toBe(false);
    }
    const done = apply(
      apply(running().state, 'StartModelRequest', payload).state,
      'SettleModelRequest',
      settlement(),
    ).state;
    for (const patch of [
      { connectionRevision: 1 },
      { botProfileVersion: 2 },
      { connectionId: 'other' },
      { endpoint: 'other' },
      { kind: 'local' },
      { auth: 'none' },
      { artifactDigest: 'digest' },
      { backendVersion: 'v2' },
    ]) {
      const next = {
        ...payload,
        ordinal: 2,
        startedAt: '2026-01-01T00:00:03Z',
        activation: { ...payload.activation, identity: { ...identity, ...patch } },
      };
      expect(
        decide(done, cmd(done, 'StartModelRequest', next as StartModelRequestPayload)).ok,
      ).toBe(false);
    }
  });
  it('compares full activation independent of input key order', () => {
    const done = apply(pending(), 'SettleModelRequest', settlement()).state;
    const next = { ...startPayload(2), startedAt: '2026-01-01T00:00:03Z' };
    const reordered = Object.fromEntries(
      Object.entries(next.activation).reverse(),
    ) as unknown as ModelActivationSnapshot;
    expect(
      decide(done, cmd(done, 'StartModelRequest', { ...next, activation: reordered })).ok,
    ).toBe(true);
    for (const patch of [
      { capabilities: { ...activation().capabilities, tools: false } },
      {
        capabilities: { ...activation().capabilities, inputModalities: ['text', 'image'] as const },
      },
      { deadlineAt: '2026-01-01T00:09:00Z' },
      { admittedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(
        decide(
          done,
          cmd(done, 'StartModelRequest', { ...next, activation: { ...activation(), ...patch } }),
        ).ok,
      ).toBe(false);
    }
    expect(decide(done, cmd(done, 'StartModelRequest', startPayload(2))).ok).toBe(false);
  });
  it('validates settlement ownership, counters, discriminants and finish time but accepts late evidence', () => {
    const state = pending();
    const bad: unknown[] = [
      null,
      {},
      { ...settlement(), attemptId: 'other' },
      { ...settlement(), ordinal: 2 },
      { ...settlement(), finishedAt: '2026-01-01T00:00:00Z' },
      { ...settlement(), finishedAt: '2026-02-30T00:00:02Z' },
      { ...settlement(), completion: { kind: 'terminal', stopReason: 'bad' } },
      { ...settlement(), completion: null },
      { ...settlement(), usage: { kind: 'unavailable', reason: 'bad' } },
      {
        ...settlement(),
        usage: { kind: 'estimated', tokens: settlement().usage.tokens, estimator: '' },
      },
    ];
    for (const value of [-1, 0.5, Infinity, '1', Number.MAX_SAFE_INTEGER + 1])
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
        bad.push({
          ...settlement(),
          usage: { kind: 'actual', tokens: { ...settlement().usage.tokens, [key]: value } },
        });
      }
    for (const payload of bad)
      expect(
        decide(state, cmd(state, 'SettleModelRequest', payload as SettleModelRequestPayload)).ok,
      ).toBe(false);
    expect(
      decide(
        state,
        cmd(state, 'SettleModelRequest', { ...settlement(), finishedAt: '2026-01-02T00:00:00Z' }),
      ).ok,
    ).toBe(true);
    expect(
      decide(
        state,
        cmd(state, 'SettleModelRequest', {
          ...settlement(),
          usage: { kind: 'actual', tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 8 } },
        }),
      ).ok,
    ).toBe(true);
  });
  it('whitelists unknown fields and detaches arrays/evidence from caller and event mutation', () => {
    const payload = {
      ...startPayload(),
      secret: 'never-store',
      activation: {
        ...activation(),
        secret: 'never-store',
        identity: { ...activation().identity, credentialRef: 'never-store' },
        capabilities: {
          ...activation().capabilities,
          inputModalities: ['text'] as ('text' | 'image')[],
          key: 'never-store',
        },
      },
    };
    const started = apply(running().state, 'StartModelRequest', payload);
    payload.activation.capabilities.inputModalities.push('image');
    expect(started.state.modelExecution?.activation.capabilities.inputModalities).toEqual(['text']);
    expect(JSON.stringify(started.events)).not.toContain('never-store');
    const event = started.events[0];
    if (event?.type !== 'attempt.model_request_started') throw new Error('missing start');
    (event.payload.activation.capabilities.inputModalities as string[]).push('image');
    expect(started.state.modelExecution?.activation.capabilities.inputModalities).toEqual(['text']);
    const p = {
      ...settlement(),
      key: 'never-store',
      completion: { ...settlement().completion, key: 'never-store' },
      usage: {
        ...settlement().usage,
        key: 'never-store',
        tokens: { ...settlement().usage.tokens, key: 'never-store' },
      },
    };
    const settled = apply(started.state, 'SettleModelRequest', p);
    p.usage.tokens.totalTokens = 50;
    expect(settled.state.modelExecution?.lastRequest.settlement?.usage).toEqual(settlement().usage);
    expect(JSON.stringify(settled.events)).not.toContain('never-store');
    const settledEvent = settled.events[0];
    if (
      settledEvent?.type !== 'attempt.model_request_settled' ||
      settledEvent.payload.usage.kind !== 'actual'
    )
      throw new Error('missing settlement');
    (settledEvent.payload.usage.tokens as { totalTokens: number }).totalTokens = 80;
    expect(settled.state.modelExecution?.usage.knownTokens).toBe(5);
    expect(settled.state.modelExecution?.lastRequest.settlement?.usage).toEqual(settlement().usage);
    expect(settled.events[1]?.payload).toEqual({
      attemptId: 'at_test',
      usage: settlement().usage.tokens,
    });
  });
});
