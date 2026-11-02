/**
 * Budgets are immutable values. Consumption is monotonic, an outstanding
 * reservation reduces availability until it settles or releases, and a
 * settlement can never exceed what was reserved for that dimension.
 */

import { describe, expect, it } from 'vitest';
import {
  BUDGET_DIMENSIONS,
  available,
  consume,
  createBudget,
  isExhausted,
  release,
  reserve,
  settle,
  unlimitedBudget,
  type BudgetLimitsPayload,
  type DomainError,
  type Result,
  type RunBudget,
} from '@runnets/domain';

/** A fully unlimited limit set with the given dimensions overridden. */
function limits(overrides: Partial<BudgetLimitsPayload> = {}): BudgetLimitsPayload {
  return { ...unlimitedBudget(), ...overrides };
}

function expectBudget(result: Result<RunBudget>): RunBudget {
  if (!result.ok) throw new Error(`expected a budget, got ${result.error.code}`);
  return result.value;
}

function expectError(result: Result<RunBudget>): DomainError {
  if (result.ok) throw new Error('expected a budget error, got a value');
  return result.error;
}

describe('createBudget', () => {
  it('starts every dimension at zero consumption and zero reservation', () => {
    const budget = createBudget(limits({ tool_calls: 10, provider_tokens: 500 }));
    for (const dimension of BUDGET_DIMENSIONS) {
      expect(budget.consumed[dimension]).toBe(0);
      expect(budget.reserved[dimension]).toBe(0);
    }
    expect(budget.limits.tool_calls).toBe(10);
    expect(budget.limits.provider_tokens).toBe(500);
    expect(budget.limits.active_time_ms).toBeNull();
  });

  it('rejects negative, infinite, and non-numeric limits', () => {
    for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createBudget(limits({ tool_calls: limit }))).toThrow(RangeError);
    }
  });
});

describe('available', () => {
  it('returns unused capacity of a limited dimension', () => {
    expect(available(createBudget(limits({ tool_calls: 10 })), 'tool_calls')).toBe(10);
  });

  it('returns infinity for an unlimited dimension', () => {
    expect(available(createBudget(limits()), 'provider_cost_usd')).toBe(Number.POSITIVE_INFINITY);
  });

  it('subtracts outstanding reservations from availability', () => {
    const budget = expectBudget(reserve(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 4));
    expect(available(budget, 'tool_calls')).toBe(6);
  });
});

describe('reserve', () => {
  it('holds capacity without consuming it', () => {
    const budget = expectBudget(reserve(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 4));
    expect(budget.reserved.tool_calls).toBe(4);
    expect(budget.consumed.tool_calls).toBe(0);
    expect(available(budget, 'tool_calls')).toBe(6);
  });

  it('rejects a reservation larger than the available capacity', () => {
    const error = expectError(reserve(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 11));
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ dimension: 'tool_calls', available: 10 });
  });

  it('allows reserving exactly the available capacity', () => {
    const reserved = expectBudget(
      reserve(createBudget(limits({ tool_calls: 3 })), 'tool_calls', 3),
    );
    expect(available(reserved, 'tool_calls')).toBe(0);
    expect(expectError(reserve(reserved, 'tool_calls', 1)).code).toBe('invariant_violation');
  });

  it('rejects negative and non-finite amounts', () => {
    const budget = createBudget(limits({ tool_calls: 10 }));
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expectError(reserve(budget, 'tool_calls', amount)).code).toBe('invalid_argument');
    }
  });
});

describe('settle', () => {
  it('consumes the settled amount and clears it from the reservation', () => {
    let budget = createBudget(limits({ provider_cost_usd: 100 }));
    budget = expectBudget(reserve(budget, 'provider_cost_usd', 40));
    budget = expectBudget(settle(budget, 'provider_cost_usd', 25));
    expect(budget.consumed.provider_cost_usd).toBe(25);
    expect(budget.reserved.provider_cost_usd).toBe(15);
    expect(available(budget, 'provider_cost_usd')).toBe(60);
  });

  it('keeps consumption monotonic across settle, release, and consume', () => {
    let budget = createBudget(limits({ tool_calls: 10 }));
    const consumed = [budget.consumed.tool_calls];
    budget = expectBudget(reserve(budget, 'tool_calls', 4));
    budget = expectBudget(settle(budget, 'tool_calls', 3));
    consumed.push(budget.consumed.tool_calls);
    budget = expectBudget(release(budget, 'tool_calls', 1));
    consumed.push(budget.consumed.tool_calls);
    budget = expectBudget(consume(budget, 'tool_calls', 2));
    consumed.push(budget.consumed.tool_calls);
    // Consumption never decreases; releasing a reservation does not refund it.
    expect(consumed).toEqual([0, 3, 3, 5]);
  });

  it('rejects settlement beyond the reserved amount', () => {
    const held = expectBudget(
      reserve(createBudget(limits({ provider_tokens: 1000 })), 'provider_tokens', 10),
    );
    const error = expectError(settle(held, 'provider_tokens', 11));
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ dimension: 'provider_tokens', reserved: 10, actual: 11 });
    expect(held.consumed.provider_tokens).toBe(0);
  });

  it('rejects settlement without a reservation', () => {
    const budget = createBudget(limits({ provider_tokens: 1000 }));
    expect(expectError(settle(budget, 'provider_tokens', 1)).code).toBe('invariant_violation');
  });

  it('rejects negative and non-finite settlements', () => {
    const held = expectBudget(reserve(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 5));
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expectError(settle(held, 'tool_calls', amount)).code).toBe('invalid_argument');
    }
  });
});

describe('release', () => {
  it('returns unconsumed capacity to availability without touching consumption', () => {
    let budget = createBudget(limits({ tool_calls: 10 }));
    budget = expectBudget(reserve(budget, 'tool_calls', 4));
    const released = expectBudget(release(budget, 'tool_calls', 4));
    expect(released.reserved.tool_calls).toBe(0);
    expect(released.consumed.tool_calls).toBe(0);
    expect(available(released, 'tool_calls')).toBe(10);
  });

  it('releases only what remains reserved after settlement', () => {
    let budget = createBudget(limits({ tool_calls: 10 }));
    budget = expectBudget(reserve(budget, 'tool_calls', 10));
    budget = expectBudget(settle(budget, 'tool_calls', 4));
    const error = expectError(release(budget, 'tool_calls', 7));
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ dimension: 'tool_calls', reserved: 6, amount: 7 });
    const released = expectBudget(release(budget, 'tool_calls', 6));
    expect(released.reserved.tool_calls).toBe(0);
    expect(released.consumed.tool_calls).toBe(4);
  });

  it('rejects negative and non-finite releases', () => {
    const held = expectBudget(reserve(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 5));
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expectError(release(held, 'tool_calls', amount)).code).toBe('invalid_argument');
    }
  });
});

describe('consume', () => {
  it('adds consumption without requiring a reservation', () => {
    const budget = expectBudget(consume(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 3));
    expect(budget.consumed.tool_calls).toBe(3);
    expect(budget.reserved.tool_calls).toBe(0);
    expect(available(budget, 'tool_calls')).toBe(7);
  });

  it('rejects negative and non-finite consumption', () => {
    const budget = createBudget(limits({ tool_calls: 10 }));
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(expectError(consume(budget, 'tool_calls', amount)).code).toBe('invalid_argument');
    }
  });
});

describe('isExhausted', () => {
  it('returns null while every limited dimension stays below its limit', () => {
    const budget = expectBudget(consume(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 9));
    expect(isExhausted(budget)).toBeNull();
  });

  it('reports the dimension whose consumption reached the limit', () => {
    const budget = expectBudget(
      consume(createBudget(limits({ tool_calls: 10 })), 'tool_calls', 10),
    );
    expect(isExhausted(budget)).toEqual({ dimension: 'tool_calls', limit: 10, consumed: 10 });
  });

  it('reports exhaustion reached through reservation and settlement', () => {
    let budget = createBudget(limits({ provider_tokens: 10 }));
    budget = expectBudget(reserve(budget, 'provider_tokens', 10));
    budget = expectBudget(settle(budget, 'provider_tokens', 10));
    expect(isExhausted(budget)).toEqual({
      dimension: 'provider_tokens',
      limit: 10,
      consumed: 10,
    });
  });

  it('ignores unlimited dimensions', () => {
    const spent = expectBudget(consume(createBudget(limits()), 'provider_cost_usd', 1_000_000));
    expect(isExhausted(spent)).toBeNull();
  });

  it('reports the first exhausted dimension in declaration order', () => {
    const budget = createBudget(limits({ provider_cost_usd: 1, tool_calls: 1 }));
    const usd = expectBudget(consume(budget, 'provider_cost_usd', 1));
    const both = expectBudget(consume(usd, 'tool_calls', 1));
    expect(isExhausted(both)).toEqual({
      dimension: 'provider_cost_usd',
      limit: 1,
      consumed: 1,
    });
  });
});

describe('immutability', () => {
  it('never mutates the budget it received', () => {
    const original = createBudget(limits({ tool_calls: 10 }));
    const reserved = expectBudget(reserve(original, 'tool_calls', 4));
    const settled = expectBudget(settle(reserved, 'tool_calls', 2));
    const released = expectBudget(release(settled, 'tool_calls', 2));
    const consumed = expectBudget(consume(released, 'tool_calls', 1));
    expect(original).toEqual(createBudget(limits({ tool_calls: 10 })));
    expect(reserved.reserved.tool_calls).toBe(4);
    expect(settled.reserved.tool_calls).toBe(2);
    expect(consumed.consumed.tool_calls).toBe(3);
  });
});
