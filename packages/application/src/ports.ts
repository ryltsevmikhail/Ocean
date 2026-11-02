/**
 * Application ports.
 *
 * The domain is pure; everything that touches time, identity, or durability is
 * declared here and implemented by adapters. Ports are the only place the
 * application layer admits I/O.
 */

import type { CommandCommitPort } from './command-commit.js';

import type { EventEnvelope, TaskRunEvent, TaskRunEventDraft, TaskRunId } from '@runnets/domain';

/** Wall clock, injected so tests and replays are deterministic. */
export interface Clock {
  now(): Date;
}

/** Identity source for events and commands. */
export interface IdGenerator {
  eventId(): string;
  commandId(): string;
}

/** Receipt for a committed command; replayed verbatim on duplicate submission. */
export interface CommandReceipt {
  readonly commandId: string;
  readonly taskRunId: TaskRunId;
  readonly version: number;
  readonly events: readonly TaskRunEvent[];
}

export type AppendOutcome =
  | { readonly ok: true; readonly events: readonly TaskRunEvent[] }
  | { readonly ok: false; readonly actualVersion: number };

/**
 * Durable, per-aggregate ordered event log.
 *
 * `append` and the optional atomic command writer enforce optimistic concurrency: a
 * mismatched expected version commits nothing.
 */
export interface EventLogPort {
  /** When present, events and request-bound receipts share one commit boundary. */
  readonly commands?: CommandCommitPort;
  listTaskRuns?(): Promise<readonly TaskRunId[]>;
  load(taskRunId: TaskRunId): Promise<readonly EventEnvelope[]>;
  append(
    taskRunId: TaskRunId,
    expectedVersion: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): Promise<AppendOutcome>;
}

export interface AppendMeta {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly actorId: string;
}

/**
 * Idempotency store for commands.
 *
 * A command id that already committed must return its original receipt, not
 * re-execute. Adapters may implement this in memory or durably.
 */
export interface CommandDedupPort {
  get(commandId: string): Promise<CommandReceipt | null>;
  put(receipt: CommandReceipt): Promise<void>;
}
