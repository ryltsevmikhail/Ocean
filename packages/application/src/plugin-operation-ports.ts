/**
 * Owner-visible durable plugin operation journal.
 *
 * `PluginOperationStorePort` is the only reader/writer of
 * `ocean_plugin_operations`. It never carries a credential value or a raw
 * provider payload: arguments are bounded canonical JSON, results are bounded
 * summaries, and an owner acknowledgement preserves the fact of uncertainty
 * while releasing the journal's global unknown-effect hold.
 */

import type { PluginOperationRecord, PluginOperationState } from '@runnets/domain';

export interface PluginOperationFilter {
  readonly workspaceId?: string;
  readonly roomId?: string;
  readonly botId?: string;
  readonly state?: PluginOperationState;
  readonly limit?: number;
}

/** Compare-and-set owner acknowledgement of one uncertain operation. */
export interface PluginOperationAcknowledgeInput {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly at: string;
}

export interface PluginOperationStorePort {
  list(filter?: PluginOperationFilter): readonly PluginOperationRecord[];
  get(operationId: string): PluginOperationRecord | null;
  /** Rows whose effect is still unknown; they keep the global journal hold. */
  open(): readonly PluginOperationRecord[];
  /**
   * Startup-only lowering of `started` rows to `uncertain` (never a replay
   * permission). Returns how many rows were lowered.
   */
  recoverStarted(at: string): number;
  /**
   * One transaction: compare-and-set the operation revision, record the
   * acknowledgement and release exactly this effect's journal hold. Never claims
   * remote certainty and never authorizes a retry.
   */
  acknowledge(input: PluginOperationAcknowledgeInput): PluginOperationRecord;
}
