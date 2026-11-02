/**
 * Side-effect outcomes are audited, never rewritten. An uncertain outcome is
 * never automatically retryable, because the external system may already hold
 * the effect; compensation adds a record instead of editing history.
 */

import { describe, expect, it } from 'vitest';
import {
  SIDE_EFFECT_STATES,
  SIDE_EFFECT_TRANSITIONS,
  TERMINAL_SIDE_EFFECT_STATES,
  canTransition,
  requiresReconciliation,
  retryVerdict,
  transition,
  type SideEffectState,
} from '@runnets/domain';

const LEGAL: ReadonlyArray<readonly [SideEffectState, SideEffectState]> = [
  ['planned', 'denied'],
  ['planned', 'authorized'],
  ['authorized', 'started'],
  ['started', 'failed_before_commit'],
  ['started', 'confirmed'],
  ['started', 'uncertain'],
  ['uncertain', 'confirmed'],
  ['uncertain', 'compensated'],
  ['uncertain', 'reconciliation_failed'],
  ['confirmed', 'compensated'],
];

const ILLEGAL: ReadonlyArray<readonly [SideEffectState, SideEffectState]> = [
  ['planned', 'started'],
  ['planned', 'confirmed'],
  ['denied', 'authorized'],
  ['denied', 'planned'],
  ['authorized', 'confirmed'],
  ['started', 'compensated'],
  ['started', 'authorized'],
  ['confirmed', 'uncertain'],
  ['confirmed', 'started'],
  ['compensated', 'confirmed'],
  ['failed_before_commit', 'confirmed'],
  ['reconciliation_failed', 'confirmed'],
  ['uncertain', 'started'],
  ['planned', 'planned'],
];

describe('side-effect transitions', () => {
  it('allows every legal transition', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('rejects every illegal transition', () => {
    for (const [from, to] of ILLEGAL) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it('agrees with the declared transition table for every state pair', () => {
    for (const from of SIDE_EFFECT_STATES) {
      const allowed = SIDE_EFFECT_TRANSITIONS[from] as readonly SideEffectState[];
      for (const to of SIDE_EFFECT_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.includes(to));
      }
    }
  });

  it('returns the target state for a legal transition', () => {
    for (const [from, to] of LEGAL) {
      expect(transition(from, to)).toEqual({ ok: true, value: to });
    }
  });

  it('rejects an illegal transition with invariant_violation', () => {
    for (const [from, to] of ILLEGAL) {
      const result = transition(from, to);
      expect(result.ok, `${from} -> ${to}`).toBe(false);
      if (result.ok) throw new Error(`expected ${from} -> ${to} to be rejected`);
      expect(result.error.code).toBe('invariant_violation');
      expect(result.error.details).toEqual({ from, to });
      expect(result.error.message).toContain(`${from} -> ${to}`);
    }
  });
});

describe('requiresReconciliation', () => {
  it('is true only for recorded but unresolved outcomes', () => {
    for (const state of SIDE_EFFECT_STATES) {
      expect(requiresReconciliation(state), state).toBe(
        state === 'uncertain' || state === 'reconciliation_failed',
      );
    }
  });
});

describe('retryVerdict', () => {
  it('never classifies an uncertain outcome as safe to retry', () => {
    const verdict = retryVerdict('uncertain');
    expect(verdict.kind).toBe('requires_reconciliation');
    expect(verdict.kind).not.toBe('safe');
  });

  it('requires reconciliation when reconciliation itself failed', () => {
    expect(retryVerdict('reconciliation_failed').kind).toBe('requires_reconciliation');
  });

  it('permits retry only after a provable pre-commit failure', () => {
    const verdict = retryVerdict('failed_before_commit');
    expect(verdict.kind).toBe('safe');
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('forbids retry for denied and already committed effects', () => {
    for (const state of ['denied', 'confirmed', 'compensated'] as const) {
      expect(retryVerdict(state).kind, state).toBe('forbidden');
    }
  });

  it('forbids retry while the effect is still in flight', () => {
    for (const state of ['planned', 'authorized', 'started'] as const) {
      expect(retryVerdict(state).kind, state).toBe('forbidden');
    }
  });
});

describe('terminal side-effect states', () => {
  it('declares denied, failed_before_commit, compensated, and reconciliation_failed', () => {
    expect(TERMINAL_SIDE_EFFECT_STATES).toEqual([
      'denied',
      'failed_before_commit',
      'compensated',
      'reconciliation_failed',
    ]);
  });

  it('lets no terminal outcome transition anywhere', () => {
    for (const state of TERMINAL_SIDE_EFFECT_STATES) {
      expect(SIDE_EFFECT_TRANSITIONS[state]).toEqual([]);
      for (const target of SIDE_EFFECT_STATES) {
        expect(canTransition(state, target), `${state} -> ${target}`).toBe(false);
      }
    }
  });

  it('keeps uncertain non-terminal so reconciliation can resolve it', () => {
    expect(TERMINAL_SIDE_EFFECT_STATES).not.toContain('uncertain');
    expect(canTransition('uncertain', 'confirmed')).toBe(true);
    expect(canTransition('uncertain', 'compensated')).toBe(true);
    expect(canTransition('uncertain', 'reconciliation_failed')).toBe(true);
  });

  it('allows compensating a confirmed effect without reopening it', () => {
    expect(transition('confirmed', 'compensated')).toEqual({ ok: true, value: 'compensated' });
    expect(canTransition('compensated', 'confirmed')).toBe(false);
    expect(canTransition('compensated', 'uncertain')).toBe(false);
  });
});
