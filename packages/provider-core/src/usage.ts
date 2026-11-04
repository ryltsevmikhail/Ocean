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

export interface TokenUsageRetention {
  readonly usage: TokenUsage;
  readonly conflict: boolean;
}

/** Retain an observed greatest-total tuple, never summed or componentwise invented. */
export function retainTokenUsage(
  previous: TokenUsage | null,
  next: TokenUsage,
): TokenUsageRetention {
  const conflict =
    previous !== null &&
    (next.inputTokens < previous.inputTokens ||
      next.outputTokens < previous.outputTokens ||
      next.totalTokens < previous.totalTokens);
  return {
    usage:
      conflict && previous !== null && previous.totalTokens >= next.totalTokens ? previous : next,
    conflict,
  };
}
