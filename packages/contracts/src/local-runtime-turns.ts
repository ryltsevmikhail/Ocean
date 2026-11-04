import { localRuntimeRecord } from './local-runtime.js';

export interface LocalRoomScope {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface LocalReceiptQuery extends LocalRoomScope {
  readonly requestId: string;
}
export interface LocalRunQuery extends LocalRoomScope {
  readonly runId: string;
}
export interface LocalTurnRequest extends LocalReceiptQuery {
  readonly text: string;
  readonly to?: string;
  readonly taskId?: string;
}
export interface LocalTurnReceipt extends LocalReceiptQuery {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly runId: string | null;
}
const turnStates = [
  'queued',
  'accepted',
  'dispatching',
  'prepared',
  'completed',
  'failed',
  'uncertain',
  'cancelled',
] as const;
const taskStates = [
  'admitted_before_run',
  'not_created',
  'created',
  'queued',
  'admitted',
  'running',
  'waiting',
  'retrying',
  'checkpointing',
  'reconciling',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'unrecoverable',
] as const;
export interface LocalRunSnapshot extends LocalTurnReceipt {
  readonly turnId: string;
  readonly runId: string;
  readonly pendingDecisionIds?: readonly string[];
  readonly performerId: string;
  readonly turnStatus: (typeof turnStates)[number];
  readonly taskStatus: (typeof taskStates)[number];
  readonly version: number;
  readonly resultMessageId: string | null;
}

const id = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
function scope(v: Record<string, unknown>) {
  return id(v['workspaceId']) && id(v['roomId']);
}
const receiptKeys = ['workspaceId', 'roomId', 'requestId'];
function only(v: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
export function isLocalReceiptQuery(v: unknown): v is LocalReceiptQuery {
  return localRuntimeRecord(v) && scope(v) && id(v['requestId']) && only(v, receiptKeys);
}
export function isLocalRunQuery(v: unknown): v is LocalRunQuery {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    id(v['runId']) &&
    only(v, ['workspaceId', 'roomId', 'runId'])
  );
}
export function isLocalTurnRequest(v: unknown): v is LocalTurnRequest {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    id(v['requestId']) &&
    typeof v['text'] === 'string' &&
    (v['to'] === undefined || id(v['to'])) &&
    (v['taskId'] === undefined || id(v['taskId'])) &&
    only(v, [...receiptKeys, 'text', 'to', 'taskId'])
  );
}
export function isLocalTurnReceipt(v: unknown): v is LocalTurnReceipt {
  return (
    localRuntimeRecord(v) &&
    scope(v) &&
    id(v['requestId']) &&
    id(v['messageId']) &&
    ((v['turnId'] === null && v['runId'] === null) || (id(v['turnId']) && id(v['runId'])))
  );
}
export function isLocalRunSnapshot(v: unknown): v is LocalRunSnapshot {
  return (
    localRuntimeRecord(v) &&
    isLocalTurnReceipt(v) &&
    id(v.turnId) &&
    id(v.runId) &&
    (v['pendingDecisionIds'] === undefined ||
      (Array.isArray(v['pendingDecisionIds']) &&
        v['pendingDecisionIds'].length <= 200 &&
        v['pendingDecisionIds'].every(id))) &&
    id(v['performerId']) &&
    turnStates.some((x) => x === v['turnStatus']) &&
    taskStates.some((x) => x === v['taskStatus']) &&
    typeof v['version'] === 'number' &&
    Number.isSafeInteger(v['version']) &&
    v['version'] >= 0 &&
    (v['resultMessageId'] === null || id(v['resultMessageId']))
  );
}
