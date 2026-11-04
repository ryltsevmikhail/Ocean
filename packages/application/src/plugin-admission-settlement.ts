/**
 * Classification and settlement of one admitted plugin invocation.
 *
 * The admission transaction records `started`. This module maps the transport
 * outcome onto the durable operation row and the tool journal in one atomic
 * call. A settlement failure is reported as uncertainty: the committed claim
 * still blocks replay and the visible `started` row keeps the effect unknown.
 */

import {
  boundPluginDetail,
  canonicalJson,
  sliceTextByBytes,
  truncatePluginOutput,
  PLUGIN_MAX_OPERATION_SUMMARY_BYTES,
} from '@runnets/domain';
import type { ServicePluginInvokeOutcome } from './service-plugin-transport.js';
import type { PluginAdmissionStorePort, PluginAdmissionSettlement } from './plugin-ports.js';
import type { ToolEffectContext } from './tools.js';

export interface PluginSettlementResult {
  /** The outcome the caller must report (downgraded to uncertain on failure). */
  readonly outcome: ServicePluginInvokeOutcome;
  readonly settled: boolean;
  /** Bounded model-visible text for an observed result, else null. */
  readonly summary: string | null;
}

/** Model-visible text for one observed upstream result (bounded by the caller). */
export function observedPluginText(
  outcome: Extract<ServicePluginInvokeOutcome, { kind: 'observed' }>,
): string {
  const prefix =
    outcome.code === 'vendor_error'
      ? `upstream_error ${outcome.vendorErrorCode ?? 'unknown'}: `
      : '';
  try {
    return prefix + canonicalJson(outcome.result);
  } catch {
    return prefix + '[result is not representable as JSON]';
  }
}

function journalOutcomeOf(
  outcome: ServicePluginInvokeOutcome,
): 'completed' | 'failed' | 'uncertain' | 'not_started' {
  if (outcome.kind === 'observed') return outcome.code === 'vendor_error' ? 'failed' : 'completed';
  return outcome.kind === 'uncertain' ? 'uncertain' : 'not_started';
}

/**
 * Settle one claimed invocation atomically with its operation row.
 * Never retries, never infers "no effect" from a dropped response.
 */
export function settlePluginInvocation(
  store: PluginAdmissionStorePort,
  now: () => string,
  invocationId: string,
  outcome: ServicePluginInvokeOutcome,
  context: ToolEffectContext,
): PluginSettlementResult {
  const text = outcome.kind === 'observed' ? observedPluginText(outcome) : null;
  const bounded = text === null ? null : truncatePluginOutput(text);
  const settlement: PluginAdmissionSettlement = {
    state:
      outcome.kind === 'observed'
        ? outcome.code === 'vendor_error'
          ? 'failed'
          : 'observed'
        : outcome.kind === 'uncertain'
          ? 'uncertain'
          : 'not_started',
    outcomeCode: outcome.code,
    detail:
      outcome.kind === 'observed'
        ? outcome.vendorErrorCode === null
          ? null
          : boundPluginDetail(outcome.vendorErrorCode)
        : boundPluginDetail(outcome.detail),
    resultSummary:
      bounded === null ? null : sliceTextByBytes(bounded.text, PLUGIN_MAX_OPERATION_SUMMARY_BYTES),
    resultBytes: bounded === null ? null : bounded.totalBytes,
    truncated: bounded?.truncated === true,
    settledAt: now(),
  };
  try {
    store.settleOperation(invocationId, settlement, journalOutcomeOf(outcome), context);
  } catch {
    // The durable started claim still blocks replay; report uncertainty instead
    // of claiming a result the journal cannot prove.
    return {
      outcome: {
        kind: 'uncertain',
        invocationId,
        code: 'internal_failure',
        detail: 'operation settlement failed after the durable claim',
      },
      settled: false,
      summary: null,
    };
  }
  return { outcome, settled: true, summary: bounded?.text ?? null };
}
