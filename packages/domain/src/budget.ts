/**
 * Typed run budgets.
 *
 * Consumption is monotonic and events-only: a settled amount never decreases.
 * A reservation is subtracted from `available` until it settles or releases,
 * so an unresolved reservation cannot silently free capacity.
 */

import { DomainError, err, ok, type Result } from './errors.js';
import type { BudgetLimitsPayload } from './events.js';

export const BUDGET_DIMENSIONS = [
  'active_time_ms',
  'provider_cost_usd',
  'provider_tokens',
  'tool_calls',
  'retry_attempts',
  'child_runs',
  'process_starts',
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export type BudgetLimits = Readonly<Record<BudgetDimension, number | null>>;

export type BudgetConsumed = Readonly<Record<BudgetDimension, number>>;

export interface RunBudget {
  readonly limits: BudgetLimits;
  readonly consumed: BudgetConsumed;
  /** Sum of outstanding reservations per dimension. */
  readonly reserved: BudgetConsumed;
}

export type BudgetExhaustion = {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly consumed: number;
};

export function unlimitedBudget(): BudgetLimits {
  return {
    active_time_ms: null,
    provider_cost_usd: null,
    provider_tokens: null,
    tool_calls: null,
    retry_attempts: null,
    child_runs: null,
    process_starts: null,
  };
}

function zero(): BudgetConsumed {
  return {
    active_time_ms: 0,
    provider_cost_usd: 0,
    provider_tokens: 0,
    tool_calls: 0,
    retry_attempts: 0,
    child_runs: 0,
    process_starts: 0,
  };
}

export function assertLimit(limit: number | null): void {
  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
    throw new RangeError(`budget limit must be a finite non-negative number or null, got ${limit}`);
  }
}

export function createBudget(limits: BudgetLimitsPayload): RunBudget {
  const normalized = { ...limits };
  for (const dimension of BUDGET_DIMENSIONS) assertLimit(normalized[dimension]);
  return { limits: normalized, consumed: zero(), reserved: zero() };
}

/** Capacity left for new reservations: limit minus consumed minus reserved. */
export function available(budget: RunBudget, dimension: BudgetDimension): number {
  const limit = budget.limits[dimension];
  if (limit === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, limit - budget.consumed[dimension] - budget.reserved[dimension]);
}

export function isExhausted(budget: RunBudget): BudgetExhaustion | null {
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = budget.limits[dimension];
    if (limit === null) continue;
    if (budget.consumed[dimension] >= limit) {
      return { dimension, limit, consumed: budget.consumed[dimension] };
    }
  }
  return null;
}

/** Reserve capacity before a protected or billable action is dispatched. */
export function reserve(
  budget: RunBudget,
  dimension: BudgetDimension,
  amount: number,
): Result<RunBudget> {
  if (!Number.isFinite(amount) || amount < 0) {
    return err(
      DomainError.invalidArgument(`reservation amount must be finite and >= 0, got ${amount}`),
    );
  }
  if (amount > available(budget, dimension)) {
    return err(
      DomainError.invariant(`budget ${dimension} cannot reserve ${amount}`, {
        dimension,
        available: available(budget, dimension),
      }),
    );
  }
  return ok({
    ...budget,
    reserved: { ...budget.reserved, [dimension]: budget.reserved[dimension] + amount },
  });
}

/**
 * Settle a reservation against actual usage.
 *
 * The settled amount is consumed and the reservation cleared. Settlement is
 * monotonic: `consumed` never decreases, and a settlement cannot exceed what
 * was reserved in that dimension.
 */
export function settle(
  budget: RunBudget,
  dimension: BudgetDimension,
  actual: number,
): Result<RunBudget> {
  if (!Number.isFinite(actual) || actual < 0) {
    return err(DomainError.invalidArgument(`settlement must be finite and >= 0, got ${actual}`));
  }
  const reserved = budget.reserved[dimension];
  if (actual > reserved) {
    return err(
      DomainError.invariant(`cannot settle ${actual} of ${dimension}: only ${reserved} reserved`, {
        dimension,
        reserved,
        actual,
      }),
    );
  }
  return ok({
    ...budget,
    consumed: { ...budget.consumed, [dimension]: budget.consumed[dimension] + actual },
    reserved: { ...budget.reserved, [dimension]: reserved - actual },
  });
}

/**
 * Release an unconsumed reservation.
 *
 * Only valid when no consumption boundary was crossed; after-boundary and
 * uncertain outcomes require settlement instead.
 */
export function release(
  budget: RunBudget,
  dimension: BudgetDimension,
  amount: number,
): Result<RunBudget> {
  if (!Number.isFinite(amount) || amount < 0) {
    return err(
      DomainError.invalidArgument(`release amount must be finite and >= 0, got ${amount}`),
    );
  }
  const reserved = budget.reserved[dimension];
  if (amount > reserved) {
    return err(
      DomainError.invariant(`cannot release ${amount} of ${dimension}: only ${reserved} reserved`, {
        dimension,
        reserved,
        amount,
      }),
    );
  }
  return ok({
    ...budget,
    reserved: { ...budget.reserved, [dimension]: reserved - amount },
  });
}

/** Consume without a prior reservation (e.g. a counter-only dimension). */
export function consume(
  budget: RunBudget,
  dimension: BudgetDimension,
  amount: number,
): Result<RunBudget> {
  if (!Number.isFinite(amount) || amount < 0) {
    return err(DomainError.invalidArgument(`consumption must be finite and >= 0, got ${amount}`));
  }
  return ok({
    ...budget,
    consumed: { ...budget.consumed, [dimension]: budget.consumed[dimension] + amount },
  });
}
