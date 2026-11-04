import { describe, expect, it } from 'vitest';
import { decide, type CommandPayloads, type CommandType, type TaskRunState } from '@runnets/domain';
import {
  apply,
  cmd,
  pending,
  running,
  settlement,
  startPayload,
} from '../test-fixtures/model-dispatch.js';

const guarded: [CommandType, CommandPayloads[CommandType]][] = [
  ['Complete', { attemptId: 'at_test', summary: 'done' }],
  ['Fail', { attemptId: 'at_test', failure: { code: 'provider_error', message: 'error' } }],
  ['Retry', { attemptId: 'at_test', delayMs: 0, dueAt: '2026-01-01T00:00:03Z' }],
  ['ExhaustBudget', { dimension: 'provider_tokens', consumed: 5, limit: 2 }],
  ['DenyPolicy', { capability: 'test', reason: 'test' }],
  ['Wait', { reason: 'external_input' }],
  ['BeginCheckpoint', { checkpointId: 'cp_test', attemptId: 'at_test' }],
];
describe('model lifecycle fences', () => {
  for (const unknown of [false, true]) {
    it.each([
      ['missing cleanup', {}],
      ['invalid string', { cleanup: 'unexpected' }],
      ['undefined cleanup', { cleanup: undefined }],
      ['array cleanup', { cleanup: ['forced'] }],
      ['null cleanup', { cleanup: null }],
      ['boolean cleanup', { cleanup: true }],
      ['number cleanup', { cleanup: 1 }],
      ['object cleanup', { cleanup: { kind: 'forced' } }],
      ['null payload', null],
      ['undefined payload', undefined],
    ] as const)(
      `rejects %s cleanup for ${unknown ? 'unknown' : 'pending'} inference`,
      (_, payload) => {
        let state = pending();
        if (unknown)
          state = apply(state, 'SettleModelRequest', {
            ...settlement(),
            completion: { kind: 'unknown' },
          }).state;
        const cancelling = apply(state, 'RequestCancel', { cause: 'user' }).state;
        const result = decide(
          cancelling,
          cmd(
            cancelling,
            'CompleteCleanup',
            payload as unknown as CommandPayloads['CompleteCleanup'],
          ),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('invariant_violation');
      },
    );
    it(`guards lifecycle and parking for ${unknown ? 'unknown' : 'pending'} inference`, () => {
      let state = pending();
      if (unknown)
        state = apply(state, 'SettleModelRequest', {
          ...settlement(),
          completion: { kind: 'unknown' },
        }).state;
      // Historical replay can restore running; independent model evidence still holds it.
      state = { ...state, status: 'running' };
      for (const [type, payload] of guarded)
        expect(decide(state, cmd(state, type, payload)).ok, type).toBe(false);
      expect(decide(state, cmd(state, 'StartModelRequest', startPayload(2))).ok).toBe(false);
      expect(decide(state, cmd(state, 'BeginReconcile', { reason: 'reconciliation' })).ok).toBe(
        true,
      );
      const reconciling = { ...state, status: 'reconciling' as const };
      expect(decide(reconciling, cmd(reconciling, 'ResolveReconcile', {})).ok).toBe(false);
      expect(
        decide(
          reconciling,
          cmd(reconciling, 'FailReconcile', {
            failure: { code: 'unrecoverable', message: 'error' },
          }),
        ).ok,
      ).toBe(false);
      const retrying = { ...state, status: 'retrying' as const };
      expect(
        decide(
          retrying,
          cmd(retrying, 'StartAttempt', {
            attemptId: 'other',
            provider: 'test',
            model: 'test',
            reason: 'retry',
          }),
        ).ok,
      ).toBe(false);
      const cancelling = apply(state, 'RequestCancel', { cause: 'user' }).state;
      expect(
        decide(cancelling, cmd(cancelling, 'CompleteCleanup', { cleanup: 'completed' })).ok,
      ).toBe(false);
      const forced = apply(cancelling, 'CompleteCleanup', { cleanup: 'forced' });
      expect(forced.events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
        { type: 'task_run.cancelled', payload: { cleanup: 'forced' } },
      ]);
      expect(forced.state.terminal?.summary).toBe('forced');
      expect(forced.state.modelExecution).toEqual(state.modelExecution);
    });
  }
  it('allows cancel before start and confirmed cleanup after terminal settlement', () => {
    const before = apply(running().state, 'RequestCancel', { cause: 'user' }).state;
    expect(decide(before, cmd(before, 'StartModelRequest', startPayload())).ok).toBe(false);
    expect(apply(before, 'CompleteCleanup', { cleanup: 'completed' }).state.status).toBe(
      'cancelled',
    );
    const cancelling = apply(pending(), 'RequestCancel', { cause: 'user' }).state;
    const settled = apply(cancelling, 'SettleModelRequest', settlement()).state;
    expect(settled.status).toBe('cancelling');
    expect(apply(settled, 'CompleteCleanup', { cleanup: 'completed' }).state.status).toBe(
      'cancelled',
    );
  });
  it.each(['cancelling', 'reconciling'] as const)('retains %s on unknown settlement', (status) => {
    const state: TaskRunState = { ...pending(), status };
    const result = apply(state, 'SettleModelRequest', {
      ...settlement(),
      completion: { kind: 'unknown' },
    });
    expect(result.state.status).toBe(status);
    expect(result.events.map((e) => e.type)).toEqual([
      'attempt.model_request_settled',
      'attempt.usage_recorded',
    ]);
  });
  it.each(['not_sent', 'rejected'] as const)(
    'does not complete on %s but permits explicit retry',
    (kind) => {
      const state = apply(pending(), 'SettleModelRequest', {
        ...settlement(),
        completion: { kind },
        usage: { kind: 'unavailable', reason: 'not_reported' },
      }).state;
      expect(
        decide(state, cmd(state, 'Complete', { attemptId: 'at_test', summary: 'done' })).ok,
      ).toBe(false);
      const retry = { attemptId: 'at_test', delayMs: 0, dueAt: '2026-01-01T00:00:03Z' };
      expect(decide(state, cmd(state, 'Retry', { ...retry, attemptId: 'other' })).ok).toBe(false);
      const retrying = apply(state, 'Retry', retry).state;
      const next = apply(retrying, 'StartAttempt', {
        attemptId: 'at_next',
        reason: 'retry',
        provider: 'test',
        model: 'test',
      }).state;
      expect(next.modelExecution).toEqual(state.modelExecution);
      expect(
        decide(
          next,
          cmd(next, 'StartModelRequest', {
            ...startPayload(2),
            attemptId: 'at_next',
            startedAt: '2026-01-01T00:00:03Z',
          }),
        ).ok,
      ).toBe(true);
      expect(
        decide(next, cmd(next, 'StartModelRequest', { ...startPayload(), attemptId: 'at_next' }))
          .ok,
      ).toBe(false);
    },
  );
  it.each(['unknown', 'cancelled'] as const)(
    'keeps terminal stop reason %s distinct from unknown completion',
    (stopReason) => {
      const state = apply(pending(), 'SettleModelRequest', {
        ...settlement(),
        completion: { kind: 'terminal', stopReason },
      }).state;
      expect(
        decide(state, cmd(state, 'Complete', { attemptId: 'at_test', summary: 'done' })).ok,
      ).toBe(true);
    },
  );
  it('rejects parked settlement but preserves resume/checkpoint restoration and old replay semantics', () => {
    const state = pending();
    for (const status of [
      'created',
      'queued',
      'admitted',
      'waiting',
      'retrying',
      'checkpointing',
    ] as const) {
      const parked = { ...state, status };
      expect(decide(parked, cmd(parked, 'SettleModelRequest', settlement())).ok).toBe(false);
      expect(decide(parked, cmd(parked, 'StartModelRequest', startPayload())).ok).toBe(false);
    }
    const waiting = { ...state, status: 'waiting' as const };
    const resumed = apply(waiting, 'Resume', {}).state;
    expect(apply(resumed, 'SettleModelRequest', settlement()).state.status).toBe('running');
    const checkpointing = {
      ...state,
      status: 'checkpointing' as const,
      pendingCheckpointId: 'cp_test',
    };
    const committed = apply(checkpointing, 'CommitCheckpoint', {
      checkpointId: 'cp_test',
      eventPosition: state.version,
    }).state;
    expect(apply(committed, 'SettleModelRequest', settlement()).state.status).toBe('running');
  });
  it('preserves envelope fences before the model guard and terminal immutability', () => {
    const state = pending(),
      command = cmd(state, 'Complete', { attemptId: 'at_test', summary: '' });
    const stale = decide(state, { ...command, expectedVersion: 0 });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    const cancelled = apply(
      apply(state, 'RequestCancel', { cause: 'user' }).state,
      'CompleteCleanup',
      { cleanup: 'forced' },
    ).state;
    const result = decide(cancelled, cmd(cancelled, 'SettleModelRequest', settlement()));
    expect(!result.ok && result.error.code).toBe('terminal_state');
  });
});
