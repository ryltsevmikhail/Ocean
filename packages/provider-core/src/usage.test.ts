import { expect, it } from 'vitest';
import { retainTokenUsage, validateTokenUsage } from './usage.js';
const first = { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
it.each([
  [null, first, first, false],
  [first, first, first, false],
  [
    first,
    { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
    false,
  ],
  [
    first,
    { inputTokens: 4, outputTokens: 20, totalTokens: 24 },
    { inputTokens: 4, outputTokens: 20, totalTokens: 24 },
    true,
  ],
  [
    { inputTokens: 2, outputTokens: 5, totalTokens: 7 },
    { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    true,
  ],
  [first, { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, first, true],
  [first, { inputTokens: 4, outputTokens: 3, totalTokens: 7 }, first, true],
])(
  'retains one actually observed greatest-total tuple and reports conflict (%#)',
  (previous, next, usage, conflict) => {
    expect(retainTokenUsage(previous, next)).toEqual({ usage, conflict });
  },
);
it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'refuses invalid counts (%s)',
  (inputTokens) => {
    expect(validateTokenUsage({ inputTokens, outputTokens: 2, totalTokens: 7 })).toBeNull();
  },
);
