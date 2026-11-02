/**
 * Side-effect lifecycle.
 *
 * A side effect has durable identity before it is executed, and an uncertain
 * outcome is never automatically retried: it requires reconciliation evidence.
 * Compensating an effect adds a new record; history is never rewritten.
 */

import { DomainError, err, ok, type Result } from './errors.js';

export const SIDE_EFFECT_STATES = [
  'planned',
  'denied',
  'authorized',
  'started',
  'failed_before_commit',
  'confirmed',
  'uncertain',
  'compensated',
  'reconciliation_failed',
] as const;

export type SideEffectState = (typeof SIDE_EFFECT_STATES)[number];

/**
 * The only legal transitions. `confirmed -> compensated` creates a new
 * compensating record while leaving the original confirmation intact.
 */
export const SIDE_EFFECT_TRANSITIONS = {
  planned: ['denied', 'authorized'],
  denied: [],
  authorized: ['started'],
  started: ['failed_before_commit', 'confirmed', 'uncertain'],
  uncertain: ['confirmed', 'compensated', 'reconciliation_failed'],
  confirmed: ['compensated'],
  failed_before_commit: [],
  compensated: [],
  reconciliation_failed: [],
} as const satisfies Readonly<Record<SideEffectState, readonly SideEffectState[]>>;

export const TERMINAL_SIDE_EFFECT_STATES = [
  'denied',
  'failed_before_commit',
  'compensated',
  'reconciliation_failed',
] as const satisfies readonly SideEffectState[];

/** How a caller is allowed to react to an outcome. */
export type RetryVerdict =
  | { readonly kind: 'safe'; readonly reason: string }
  | { readonly kind: 'requires_reconciliation'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

export function canTransition(from: SideEffectState, to: SideEffectState): boolean {
  return (SIDE_EFFECT_TRANSITIONS[from] as readonly SideEffectState[]).includes(to);
}

export function transition(from: SideEffectState, to: SideEffectState): Result<SideEffectState> {
  if (!canTransition(from, to)) {
    return err(
      DomainError.invariant(`illegal side-effect transition ${from} -> ${to}`, { from, to }),
    );
  }
  return ok(to);
}

/** True when the outcome is recorded but not resolved. */
export function requiresReconciliation(state: SideEffectState): boolean {
  return state === 'uncertain' || state === 'reconciliation_failed';
}

/**
 * Decide whether the effect may be attempted again.
 *
 * `uncertain` must never auto-retry: the external system may already hold the
 * effect. Only a provable pre-commit failure is safe to retry.
 */
export function retryVerdict(state: SideEffectState): RetryVerdict {
  switch (state) {
    case 'denied':
      return { kind: 'forbidden', reason: 'effect was denied; no side effect occurred' };
    case 'failed_before_commit':
      return { kind: 'safe', reason: 'failed before the commit boundary' };
    case 'uncertain':
    case 'reconciliation_failed':
      return {
        kind: 'requires_reconciliation',
        reason: 'outcome is unproven; automatic retry could duplicate the effect',
      };
    case 'confirmed':
    case 'compensated':
      return { kind: 'forbidden', reason: 'effect already committed' };
    case 'planned':
    case 'authorized':
    case 'started':
      return { kind: 'forbidden', reason: 'effect is not in a terminal outcome state' };
  }
}
