/**
 * Branded identifiers.
 *
 * Identity is immutable and typed: a `TaskRunId` can never be passed where an
 * `AttemptId` is expected. Constructors validate the wire form so invalid
 * identities cannot enter the domain.
 */

declare const idBrand: unique symbol;

type Brand<TBase, TTag extends string> = TBase & { readonly [idBrand]: TTag };

export type TaskRunId = Brand<string, 'TaskRunId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type EventId = Brand<string, 'EventId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;
export type ToolInvocationId = Brand<string, 'ToolInvocationId'>;
export type SideEffectId = Brand<string, 'SideEffectId'>;
export type PolicyId = Brand<string, 'PolicyId'>;
export type ProcessId = Brand<string, 'ProcessId'>;

/** Prefixes keep identities readable in logs and event fixtures. */
export const ID_PREFIX = {
  taskRun: 'tr',
  attempt: 'at',
  event: 'ev',
  conversation: 'cv',
  workspace: 'ws',
  checkpoint: 'cp',
  toolInvocation: 'ti',
  sideEffect: 'se',
  policy: 'pl',
  process: 'px',
} as const;

const ID_PATTERN = /^[a-z]{2}_[a-z0-9][a-z0-9_-]{2,62}$/;

/** Structural identity validation shared by every constructor. */
export function isValidId(raw: string, prefix: string): boolean {
  if (raw.length > 65 || !ID_PATTERN.test(raw)) return false;
  return raw.startsWith(`${prefix}_`);
}

function brandId<TId extends string>(kind: string, prefix: string, raw: string): TId {
  if (!isValidId(raw, prefix)) {
    throw new RangeError(
      `invalid ${kind}: expected ${prefix}_<id>, received ${JSON.stringify(raw)}`,
    );
  }
  return raw as TId;
}

export const taskRunId = (raw: string): TaskRunId => brandId('TaskRunId', ID_PREFIX.taskRun, raw);
export const attemptId = (raw: string): AttemptId => brandId('AttemptId', ID_PREFIX.attempt, raw);
export const eventId = (raw: string): EventId => brandId('EventId', ID_PREFIX.event, raw);
export const conversationId = (raw: string): ConversationId =>
  brandId('ConversationId', ID_PREFIX.conversation, raw);
export const workspaceId = (raw: string): WorkspaceId =>
  brandId('WorkspaceId', ID_PREFIX.workspace, raw);
export const checkpointId = (raw: string): CheckpointId =>
  brandId('CheckpointId', ID_PREFIX.checkpoint, raw);
export const toolInvocationId = (raw: string): ToolInvocationId =>
  brandId('ToolInvocationId', ID_PREFIX.toolInvocation, raw);
export const sideEffectId = (raw: string): SideEffectId =>
  brandId('SideEffectId', ID_PREFIX.sideEffect, raw);
export const policyId = (raw: string): PolicyId => brandId('PolicyId', ID_PREFIX.policy, raw);
export const processId = (raw: string): ProcessId => brandId('ProcessId', ID_PREFIX.process, raw);
