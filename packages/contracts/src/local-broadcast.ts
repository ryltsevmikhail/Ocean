/**
 * Local-runtime broadcast contract.
 *
 * A batch DTO is metadata only: frozen recipient identities, the single user
 * message identity, the context boundary, per-child durable state and a
 * monotonic revision for explicit owner votes. No client may infer a state the
 * runtime has not persisted.
 */

import { localRuntimeRecord } from './local-runtime.js';

export const LOCAL_BROADCAST_METHODS = [
  'broadcasts.submit',
  'broadcasts.get',
  'broadcasts.list',
  'broadcasts.continue',
  'broadcasts.abandon',
] as const;
export const BROADCAST_MAX_TEXT = 16384;
export const BROADCAST_MAX_ATTACHMENTS = 4;
export const BROADCAST_MAX_RECIPIENTS = 32;
export const BROADCAST_MAX_BATCHES = 50;

export type LocalBroadcastState = 'open' | 'paused' | 'completed' | 'abandoned' | 'refused';
export type LocalBroadcastChildState =
  'queued' | 'running' | 'answered' | 'refused' | 'uncertain' | 'cancelled' | 'not_started';
export interface LocalBroadcastChild {
  readonly botId: string;
  readonly handle: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly turnId: string;
  readonly runId: string;
  readonly position: number;
  readonly state: LocalBroadcastChildState;
  readonly resultMessageId: string | null;
}
export interface LocalBroadcastBatch {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly boundarySeq: number;
  readonly recipients: readonly LocalBroadcastChild[];
  readonly state: LocalBroadcastState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LocalBroadcastSubmit {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly text: string;
  readonly attachments?: readonly string[];
}
export interface LocalBroadcastGet {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly batchId?: string;
  readonly requestId?: string;
}
export interface LocalBroadcastList {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface LocalBroadcastVote {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly batchId: string;
  readonly expectedRevision: number;
}

const localId = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
const position = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const states: readonly LocalBroadcastState[] = [
  'open',
  'paused',
  'completed',
  'abandoned',
  'refused',
];
const childStates: readonly LocalBroadcastChildState[] = [
  'queued',
  'running',
  'answered',
  'refused',
  'uncertain',
  'cancelled',
  'not_started',
];
function only(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((key) => keys.includes(key));
}
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((key) => Object.hasOwn(v, key))
  );
}
export function isLocalBroadcastChild(v: unknown): v is LocalBroadcastChild {
  return (
    exact(v, [
      'botId',
      'handle',
      'name',
      'provider',
      'model',
      'turnId',
      'runId',
      'position',
      'state',
      'resultMessageId',
    ]) &&
    localId(v['botId']) &&
    localId(v['handle']) &&
    localId(v['name']) &&
    localId(v['provider']) &&
    localId(v['model']) &&
    localId(v['turnId']) &&
    localId(v['runId']) &&
    position(v['position']) &&
    childStates.some((state) => state === v['state']) &&
    (v['resultMessageId'] === null || localId(v['resultMessageId']))
  );
}
export function isLocalBroadcastBatch(v: unknown): v is LocalBroadcastBatch {
  return (
    exact(v, [
      'version',
      'id',
      'workspaceId',
      'roomId',
      'requestId',
      'messageId',
      'boundarySeq',
      'recipients',
      'state',
      'revision',
      'createdAt',
      'updatedAt',
    ]) &&
    v['version'] === 1 &&
    localId(v['id']) &&
    v['workspaceId'] === 'ws_ocean' &&
    localId(v['roomId']) &&
    localId(v['requestId']) &&
    localId(v['messageId']) &&
    position(v['boundarySeq']) &&
    v['boundarySeq'] >= 1 &&
    Array.isArray(v['recipients']) &&
    v['recipients'].length >= 2 &&
    v['recipients'].length <= BROADCAST_MAX_RECIPIENTS &&
    v['recipients'].every(isLocalBroadcastChild) &&
    states.some((state) => state === v['state']) &&
    position(v['revision']) &&
    v['revision'] >= 1 &&
    typeof v['createdAt'] === 'string' &&
    Number.isFinite(Date.parse(v['createdAt'])) &&
    typeof v['updatedAt'] === 'string' &&
    Number.isFinite(Date.parse(v['updatedAt']))
  );
}
export function isLocalBroadcastSubmit(v: unknown): v is LocalBroadcastSubmit {
  return (
    localRuntimeRecord(v) &&
    only(v, ['workspaceId', 'roomId', 'requestId', 'text', 'attachments']) &&
    v['workspaceId'] === 'ws_ocean' &&
    localId(v['roomId']) &&
    localId(v['requestId']) &&
    typeof v['text'] === 'string' &&
    v['text'].length > 0 &&
    v['text'].length <= BROADCAST_MAX_TEXT &&
    !v['text'].includes('\0') &&
    (v['attachments'] === undefined ||
      (Array.isArray(v['attachments']) &&
        v['attachments'].length <= BROADCAST_MAX_ATTACHMENTS &&
        v['attachments'].every(localId) &&
        new Set(v['attachments']).size === v['attachments'].length))
  );
}
export function isLocalBroadcastGet(v: unknown): v is LocalBroadcastGet {
  if (!localRuntimeRecord(v) || !only(v, ['workspaceId', 'roomId', 'batchId', 'requestId']))
    return false;
  const hasBatch = v['batchId'] !== undefined;
  const hasRequest = v['requestId'] !== undefined;
  return (
    v['workspaceId'] === 'ws_ocean' &&
    localId(v['roomId']) &&
    hasBatch !== hasRequest &&
    (!hasBatch || localId(v['batchId'])) &&
    (!hasRequest || localId(v['requestId']))
  );
}
export function isLocalBroadcastList(v: unknown): v is LocalBroadcastList {
  return (
    exact(v, ['workspaceId', 'roomId']) && v['workspaceId'] === 'ws_ocean' && localId(v['roomId'])
  );
}
export function isLocalBroadcastVote(v: unknown): v is LocalBroadcastVote {
  return (
    exact(v, ['workspaceId', 'roomId', 'batchId', 'expectedRevision']) &&
    v['workspaceId'] === 'ws_ocean' &&
    localId(v['roomId']) &&
    localId(v['batchId']) &&
    position(v['expectedRevision'])
  );
}
