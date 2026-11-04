/**
 * Owner-visible durable plugin operations.
 *
 * `list`/`show` are bounded, secret-free views over the durable journal. The
 * only owner mutation is an explicit, versioned acknowledgement of one
 * uncertain operation: it preserves the uncertainty, never claims a remote
 * outcome, never retries, and releases exactly that effect's global journal hold
 * through the store transaction. Startup recovery lowers a crashed `started`
 * row to `uncertain` — never to a success and never to a replay permission.
 */

import {
  validPluginOperationId,
  validPluginOperationState,
  type PluginOperationRecord,
  type PluginOperationState,
} from '@runnets/domain';
import type { PluginOperationFilter, PluginOperationStorePort } from './plugin-operation-ports.js';
import { PluginRefusedError } from './plugin-ports.js';
import type { Clock } from './ports.js';

export interface PluginOperationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  /** Immutable endpoint binding recorded at admission. */
  readonly endpoint: string;
  readonly tool: string;
  readonly repository: string;
  readonly schemaDigest: string;
  readonly argumentsDigest: string;
  /** Bounded canonical arguments; never a credential value. */
  readonly arguments: string;
  readonly state: PluginOperationState;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  /** Bounded result summary being what the model was allowed to see. */
  readonly resultSummary: string | null;
  readonly resultBytes: number | null;
  readonly truncated: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedReason: string | null;
}

export interface PluginOperationsOptions {
  readonly store: PluginOperationStorePort;
  readonly clock: Clock;
  /** False on a restored/maintenance host: reads stay, acknowledgements refuse. */
  readonly mutationsAllowed?: boolean;
  readonly restored?: boolean;
}

export type PluginOperationQuery = PluginOperationFilter;

export interface PluginOperationAcknowledgeRequest {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export class PluginOperationsService {
  readonly #store: PluginOperationStorePort;
  readonly #clock: Clock;
  readonly #mutationsAllowed: boolean;
  readonly #restored: boolean;

  constructor(options: PluginOperationsOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#mutationsAllowed = options.mutationsAllowed ?? options.restored !== true;
    this.#restored = options.restored === true;
  }

  list(query: PluginOperationQuery = {}): readonly PluginOperationView[] {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw refuse('invalid_input');
    const filter: PluginOperationFilter = {
      limit,
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
      ...(query.roomId === undefined ? {} : { roomId: query.roomId }),
      ...(query.botId === undefined ? {} : { botId: query.botId }),
      ...(query.state === undefined ? {} : { state: query.state }),
    };
    if (query.state !== undefined && !validPluginOperationState(query.state))
      throw refuse('invalid_input');
    return this.#store.list(filter).map(operationView);
  }

  show(operationId: string): PluginOperationView {
    return operationView(this.#operation(operationId));
  }

  /** Count of rows whose effect is still unknown; they hold further claims. */
  openCount(): number {
    return this.#store.open().length;
  }

  /**
   * Explicit versioned acknowledgement of one uncertain operation. This is a
   * local owner statement ("I have seen this unknown effect"), not settlement:
   * the operation keeps `acknowledged` with the original uncertainty and no
   * remote result is claimed.
   */
  acknowledge(input: PluginOperationAcknowledgeRequest): PluginOperationView {
    this.#mutate();
    const operation = this.#operation(input.operationId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw refuse('invalid_input');
    const reason = input.reason?.trim() ?? '';
    if (reason.length > 512) throw refuse('invalid_input');
    if (operation.state !== 'uncertain') throw refuse('operation_not_uncertain');
    const acknowledged = this.#store.acknowledge({
      operationId: operation.id,
      expectedRevision: input.expectedRevision,
      reason,
      at: this.#clock.now().toISOString(),
    });
    return operationView(acknowledged);
  }

  /** Startup-only under exclusive ownership: unknown `started` rows stay unknown. */
  recover(): { readonly lowered: number } {
    const lowered = this.#store.recoverStarted(this.#clock.now().toISOString());
    return { lowered };
  }

  get restored(): boolean {
    return this.#restored;
  }

  #operation(operationId: string): PluginOperationRecord {
    if (!validPluginOperationId(operationId)) throw refuse('invalid_input');
    const record = this.#store.get(operationId);
    if (record === null) throw refuse('operation_unknown');
    return record;
  }

  #mutate(): void {
    if (!this.#mutationsAllowed) throw refuse('restore_restricted');
  }
}

function operationView(record: PluginOperationRecord): PluginOperationView {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    roomId: record.roomId,
    botId: record.botId,
    pluginId: record.pluginId,
    connectionId: record.connectionId,
    connectionGeneration: record.connectionGeneration,
    endpoint: record.endpoint,
    tool: record.tool,
    repository: record.repository,
    schemaDigest: record.schemaDigest,
    argumentsDigest: record.argumentsDigest,
    arguments: record.arguments,
    state: record.state,
    outcomeCode: record.outcomeCode,
    detail: record.detail,
    resultSummary: record.resultSummary,
    resultBytes: record.resultBytes,
    truncated: record.truncated,
    revision: record.revision,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    acknowledgedAt: record.acknowledgedAt,
    acknowledgedReason: record.acknowledgedReason,
  };
}

function refuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin operation refused: ' + code);
}
