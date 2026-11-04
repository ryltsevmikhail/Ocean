/**
 * Durable broadcast model.
 *
 * A broadcast is one owner message to a frozen, ordered recipient list. It owns
 * one batch receipt, the single user message, the context boundary and one child
 * turn identity per recipient. Child execution is never inferred from batch
 * state alone: a `queued` child was never dispatched.
 */

export type BroadcastState = 'open' | 'paused' | 'completed' | 'abandoned' | 'refused';
/** Per-recipient visible state projected from the durable child turn and batch state. */
export type BroadcastChildStatus =
  'queued' | 'running' | 'answered' | 'refused' | 'uncertain' | 'cancelled' | 'not_started';

/** Frozen recipient identity: later profile edits never change an admitted batch. */
export interface BroadcastRecipient {
  readonly botId: string;
  readonly handle: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly turnId: string;
  readonly runId: string;
  readonly position: number;
}
export interface BroadcastBatch {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  /** Frozen one-way digest of the admitted request payload; never the payload itself. */
  readonly binding: string;
  readonly messageId: string;
  readonly boundarySeq: number;
  readonly recipients: readonly BroadcastRecipient[];
  readonly state: BroadcastState;
  /** Monotonic durable version; owner votes carry it as `expectedRevision`. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export function isBroadcastState(value: unknown): value is BroadcastState {
  return ['open', 'paused', 'completed', 'abandoned', 'refused'].some((state) => state === value);
}
export function isBroadcastRecipient(value: unknown): value is BroadcastRecipient {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    ['botId', 'handle', 'name', 'provider', 'model', 'turnId', 'runId'].every(
      (key) => typeof v[key] === 'string' && v[key].length > 0,
    ) &&
    typeof v['position'] === 'number' &&
    Number.isSafeInteger(v['position']) &&
    v['position'] >= 0
  );
}
/** Validate a complete persisted batch before any caller trusts it. */
export function isBroadcastBatch(value: unknown): value is BroadcastBatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v['version'] === 1 &&
    [
      'id',
      'workspaceId',
      'roomId',
      'requestId',
      'binding',
      'messageId',
      'createdAt',
      'updatedAt',
    ].every((key) => typeof v[key] === 'string' && v[key].length > 0) &&
    typeof v['boundarySeq'] === 'number' &&
    Number.isSafeInteger(v['boundarySeq']) &&
    v['boundarySeq'] >= 1 &&
    typeof v['revision'] === 'number' &&
    Number.isSafeInteger(v['revision']) &&
    v['revision'] >= 1 &&
    isBroadcastState(v['state']) &&
    isRecipientList(v['recipients'])
  );
}
function isRecipientList(value: unknown): value is readonly BroadcastRecipient[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) return false;
  if (!value.every(isBroadcastRecipient)) return false;
  const recipients: readonly BroadcastRecipient[] = value;
  return new Set(recipients.map((recipient) => recipient.position)).size === recipients.length;
}
/** Derive the child status shown to clients; batch-level state only explains queued children. */
export function broadcastChildStatus(
  batch: Pick<BroadcastBatch, 'state'>,
  turnStatus:
    | 'queued'
    | 'accepted'
    | 'dispatching'
    | 'prepared'
    | 'completed'
    | 'failed'
    | 'uncertain'
    | 'cancelled',
): BroadcastChildStatus {
  switch (turnStatus) {
    case 'queued':
      // A queued child of an abandoned/refused batch is explicitly not started; it never ran.
      return batch.state === 'abandoned' || batch.state === 'refused' ? 'not_started' : 'queued';
    case 'accepted':
    case 'dispatching':
    case 'prepared':
      return 'running';
    case 'completed':
      return 'answered';
    case 'failed':
      return 'refused';
    case 'uncertain':
      return 'uncertain';
    case 'cancelled':
      return 'cancelled';
  }
}
