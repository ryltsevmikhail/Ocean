/** Defensive whole-request accounting; adapters still normalize vendor cumulative fields. */
import type { ModelUsageEvidence, TokenUsagePayload } from '@runnets/domain';

export interface UsageObservation {
  readonly evidence: ModelUsageEvidence | null;
  readonly conflict: boolean;
  readonly positiveActual: boolean;
}
export function emptyUsageObservation(): UsageObservation {
  return { evidence: null, conflict: false, positiveActual: false };
}
function copyTokens(tokens: TokenUsagePayload): TokenUsagePayload {
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
  };
}
function copyEvidence(evidence: ModelUsageEvidence): ModelUsageEvidence {
  if (evidence.kind === 'unavailable') return { kind: evidence.kind, reason: evidence.reason };
  const tokens = copyTokens(evidence.tokens);
  return evidence.kind === 'actual'
    ? { kind: evidence.kind, tokens }
    : { kind: evidence.kind, tokens, estimator: evidence.estimator };
}

/**
 * Actual dominates weaker evidence. Equal/nondecreasing cumulative snapshots replace,
 * never sum. A decreasing/crossed tuple latches conflict: retain an observed tuple with
 * greatest total (first on conflicting ties), without inventing componentwise maxima.
 */
export function observeUsage(
  previous: UsageObservation,
  submitted: ModelUsageEvidence,
): UsageObservation {
  const incoming = copyEvidence(submitted),
    current = previous.evidence;
  if (incoming.kind !== 'actual') {
    if (
      current?.kind === 'actual' ||
      (current?.kind === 'estimated' && incoming.kind === 'unavailable')
    )
      return previous;
    return { ...previous, evidence: incoming };
  }
  if (Object.values(incoming.tokens).some((n) => !Number.isSafeInteger(n) || n < 0))
    return { ...previous, conflict: true };
  const positiveActual =
    previous.positiveActual || Object.values(incoming.tokens).some((n) => n > 0);
  if (current?.kind !== 'actual') return { ...previous, evidence: incoming, positiveActual };
  const a = current.tokens,
    b = incoming.tokens;
  const conflict =
    previous.conflict ||
    b.inputTokens < a.inputTokens ||
    b.outputTokens < a.outputTokens ||
    b.totalTokens < a.totalTokens;
  return {
    evidence: !conflict || b.totalTokens > a.totalTokens ? incoming : current,
    conflict,
    positiveActual,
  };
}
