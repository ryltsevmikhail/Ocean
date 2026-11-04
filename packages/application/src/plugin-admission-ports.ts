/**
 * Durable plugin invocation admission ports.
 *
 * One immediate SQLite transaction rechecks the whole authority snapshot,
 * claims the invocation in the tool journal and inserts the durable operation
 * row. Settlement updates that row and the journal in one transaction, so a
 * crash can never leave a recorded result without a settled journal or a
 * settled journal without a visible operation.
 */

import type { PluginOperationRecord } from '@runnets/domain';
import type { ToolEffectContext } from './tools.js';
import type { PluginConnectionRecord, PluginInstalledVersion } from './plugin-ports.js';
import type { PluginGrantRecord } from '@runnets/domain';

export interface PluginAdmissionTransaction {
  member(workspaceId: string, roomId: string, botId: string): boolean;
  connection(connectionId: string): PluginConnectionRecord | null;
  grant(id: string): PluginGrantRecord | null;
  enabledVersion(pluginId: string): PluginInstalledVersion | null;
  /** The durable journal claim; false never dispatches. */
  claim(id: string, tool: string, context: ToolEffectContext, fingerprint: string): boolean;
  /** Durable operation row; written in the same immediate transaction as the claim. */
  beginOperation(record: PluginOperationRecord): void;
}

/** Terminal operation settlement written atomically with the journal outcome. */
export interface PluginAdmissionSettlement {
  readonly state: 'observed' | 'failed' | 'not_started' | 'uncertain';
  /** Adapter outcome code (`ok`, `vendor_error`, `deadline_exceeded`, …). */
  readonly outcomeCode: string;
  readonly detail: string | null;
  readonly resultSummary: string | null;
  /** Model-visible output bytes before truncation. */
  readonly resultBytes: number | null;
  readonly truncated: boolean;
  readonly settledAt: string;
}

export interface PluginAdmissionStorePort {
  atomic<T>(work: (tx: PluginAdmissionTransaction) => T): T;
  /**
   * One transaction: settle the operation row and the tool journal. A throw
   * leaves both unsettled (the claim still blocks replay).
   */
  settleOperation(
    invocationId: string,
    settlement: PluginAdmissionSettlement,
    journalOutcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
    context: ToolEffectContext,
  ): void;
  /** Journal-only settlement for callers that never wrote an operation row. */
  settle(
    id: string,
    outcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
    context: ToolEffectContext,
  ): void;
}
