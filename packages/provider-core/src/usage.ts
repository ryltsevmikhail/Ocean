import type { TokenUsage } from './provider.js';

/** Whole-request counts only; missing fields and detail subtotals prove nothing. */
export function validateTokenUsage(value: {
  readonly inputTokens: unknown;
  readonly outputTokens: unknown;
  readonly totalTokens: unknown;
}): TokenUsage | null {
  const { inputTokens, outputTokens, totalTokens } = value;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof totalTokens !== 'number' ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < 0 ||
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    inputTokens + outputTokens !== totalTokens
  )
    return null;
  return { inputTokens, outputTokens, totalTokens };
}

/** Repeated cumulative reports replace, never add; decreasing evidence is contradictory. */
export function retainTokenUsage(previous: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (
    previous !== null &&
    (next.inputTokens < previous.inputTokens ||
      next.outputTokens < previous.outputTokens ||
      next.totalTokens < previous.totalTokens)
  )
    throw new Error('contradictory token usage');
  return next;
}
