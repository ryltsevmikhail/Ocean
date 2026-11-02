import {
  DomainError,
  err,
  type AnyCommand,
  type Result,
  type TaskRunEventDraft,
} from '@runnets/domain';
import type { AppendMeta, CommandReceipt } from './ports.js';

/** Atomic command writes bind identity to the complete submitted request. */
export interface CommandCommitPort {
  lookup(command: AnyCommand): Promise<Result<CommandReceipt | null>>;
  commit(
    command: AnyCommand,
    version: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): Promise<Result<CommandReceipt>>;
}

/** Canonical request identity is independent of object key insertion order. */
export function commandBinding(command: AnyCommand): string {
  return JSON.stringify(canonical(command));
}

/** Detach and freeze the complete request before any asynchronous suspension. */
export function snapshotCommand(command: AnyCommand): AnyCommand {
  // Canonical traversal constructs fresh objects; freezing recursively closes
  // every mutable alias while preserving the domain's JSON payload contract.
  return freeze(canonical(command)) as AnyCommand;
}

function freeze(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

/** Reject identity reuse without disclosing the previously committed request. */
export function commandConflict(): Result<never> {
  return err(
    DomainError.invalidArgument('command id is already bound to another or unverifiable request'),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}
