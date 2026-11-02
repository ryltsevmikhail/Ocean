import { createHash } from 'node:crypto';
import {
  isDecisionReply,
  isDecisionRef,
  isContinuation,
  isLocalRoomScope,
  isLocalRoomListQuery,
  isLocalDecision,
  isReviewSnapshot,
  localRuntimeRecord,
  bindingDigest,
  localPosition,
  PREVIEW_CHUNK,
  type LocalDecision,
  type LocalDecisionReply,
  type LocalDecisionRef,
  type LocalContinuation,
  type LocalRoomListQuery,
  type LocalRoomScope,
  type LocalReviewSnapshot,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';

export interface LocalDecisionClient {
  listDecisions(q: LocalRoomListQuery): Promise<readonly LocalDecision[]>;
  getDecision(q: LocalDecisionRef): Promise<LocalDecision>;
  decisionPreview(q: LocalDecisionRef): Promise<string>;
  resolveDecision(q: LocalDecisionReply): Promise<LocalDecision>;
  reviewRoom(q: LocalRoomScope): Promise<LocalReviewSnapshot>;
  continuationApplied(q: LocalDecisionRef): Promise<boolean>;
  requestContinuation(q: LocalContinuation): Promise<LocalDecision>;
}
function invalid(): never {
  throw Error('invalid_frame');
}
function card(v: unknown, q: LocalRoomScope & { runId?: string; decisionId?: string }) {
  if (
    !isLocalDecision(v) ||
    v.workspaceId !== q.workspaceId ||
    v.roomId !== q.roomId ||
    (q.runId !== undefined && v.runId !== q.runId) ||
    (q.decisionId !== undefined && v.decisionId !== q.decisionId)
  )
    return invalid();
  return v;
}
function chunk(row: Record<string, unknown>, offset: number, length: number) {
  const text = row['text'];
  if (
    row['offset'] !== offset ||
    typeof text !== 'string' ||
    text.length !== Math.min(PREVIEW_CHUNK, length - offset)
  )
    return invalid();
  return text;
}
export function localDecisionClient(
  send: (method: string, q: unknown) => Promise<unknown>,
): LocalDecisionClient {
  return {
    async listDecisions(input) {
      const q = validatedParams(input, isLocalRoomListQuery);
      const rows = await send('decisions.list', q);
      if (!Array.isArray(rows) || rows.length > (q.limit ?? 50)) return invalid();
      return rows.map((row) => card(row, q));
    },
    async getDecision(input) {
      const q = validatedParams(input, isDecisionRef);
      return card(await send('decisions.get', q), q);
    },
    async decisionPreview(input) {
      const q = validatedParams(input, isDecisionRef),
        meta = card(await send('decisions.get', q), q);
      let preview = '';
      while (preview.length < meta.previewLength) {
        const offset = preview.length,
          row = await send('decisions.preview', { ...q, offset });
        if (!localRuntimeRecord(row)) return invalid();
        const { offset: position, text, ...m } = row;
        if (
          card(m, q).bindingDigest !== meta.bindingDigest ||
          m['previewLength'] !== meta.previewLength
        )
          return invalid();
        preview += chunk({ offset: position, text }, offset, meta.previewLength);
      }
      if (createHash('sha256').update(preview).digest('hex') !== meta.bindingDigest)
        return invalid();
      return preview;
    },
    async resolveDecision(input) {
      const q = validatedParams(input, isDecisionReply);
      const reply = card(await send('decisions.resolve', q), q);
      if (reply.bindingDigest !== q.bindingDigest || reply.status === 'pending') return invalid();
      return reply;
    },
    async continuationApplied(input) {
      const q = validatedParams(input, isDecisionRef);
      const r = await send('reviews.result', q);
      if (
        !localRuntimeRecord(r) ||
        r['workspaceId'] !== q.workspaceId ||
        r['roomId'] !== q.roomId ||
        r['runId'] !== q.runId ||
        r['decisionId'] !== q.decisionId ||
        typeof r['applied'] !== 'boolean'
      )
        return invalid();
      return r['applied'];
    },
    async requestContinuation(input) {
      const q = validatedParams(input, isContinuation);
      const c = card(await send('reviews.continue', q), q);
      return c.kind === 'continue-text-only' ? c : invalid();
    },
    async reviewRoom(input) {
      const q = validatedParams(input, isLocalRoomScope);
      let preview = '',
        version: string | undefined,
        length: number | undefined;
      do {
        const offset = preview.length,
          row = await send('reviews.get', { ...q, offset, ...(version ? { version } : {}) });
        if (
          !localRuntimeRecord(row) ||
          row['workspaceId'] !== q.workspaceId ||
          row['roomId'] !== q.roomId ||
          !bindingDigest(row['version']) ||
          !localPosition(row['length']) ||
          (length !== undefined && length !== row['length']) ||
          (version !== undefined && version !== row['version'])
        )
          return invalid();
        length = row['length'];
        version = row['version'];
        preview += chunk(row, offset, length);
      } while (preview.length < length);
      const s: unknown = JSON.parse(preview);
      if (
        !isReviewSnapshot(s) ||
        s.workspaceId !== q.workspaceId ||
        s.roomId !== q.roomId ||
        s.version !== version
      )
        return invalid();
      return s;
    },
  };
}
