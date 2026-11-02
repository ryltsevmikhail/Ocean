import type {
  ChatReviewService,
  CodingApprovalOwnerPort,
  OwnerDecisionStore,
} from '@runnets/application';
import { RuntimeOwnerDecisions } from '@runnets/application';
import type { ChatTurn } from '@runnets/domain';
import {
  PREVIEW_CHUNK,
  isContinuation,
  isDecisionChunkQuery,
  isDecisionRef,
  isDecisionReply,
  isLocalRoomListQuery,
  isReviewChunkQuery,
} from '@runnets/contracts';
import { digest, ownerPreview } from './decision-preview.js';
import { RuntimeReviews } from './reviews.js';
import type { RuntimeReply } from './queries.js';
const errors = new Set([
  'invalid_params',
  'unknown_decision',
  'review_unavailable',
  'review_conflict',
  'binding_conflict',
  'version_conflict',
  'request_conflict',
  'runtime_draining',
  'workspace_conflict',
  'invalid_input',
  'decision_inactive',
  'decision_persistence_failed',
  'decision_pending',
  'approval_required',
]);
export class RuntimeDecisions {
  readonly owner: RuntimeOwnerDecisions;
  readonly reviews: RuntimeReviews;
  #draining = false;
  constructor(store: OwnerDecisionStore, reviews: ChatReviewService) {
    this.owner = new RuntimeOwnerDecisions(store, Date.now);
    this.reviews = new RuntimeReviews(reviews, this.owner);
  }
  coding(turn: ChatTurn, signal: AbortSignal): CodingApprovalOwnerPort {
    return {
      decide: async (approval, current) => {
        const b = approval.binding;
        if (
          this.#draining ||
          !current ||
          b.operation === 'apply' ||
          b.workspaceId !== turn.workspaceId ||
          b.roomId !== turn.roomId ||
          b.runId !== turn.taskRunId ||
          b.botId !== turn.bot.id ||
          b.taskId !== turn.codingTaskId
        )
          return 'cancel';
        const preview = ownerPreview({ binding: b, preview: approval.preview });
        const outcome = await this.owner.open(
          {
            workspaceId: b.workspaceId,
            roomId: b.roomId,
            runId: b.runId,
            decisionId: approval.id,
            version: 1,
            status: 'pending',
            kind: b.operation,
            bindingDigest: digest(preview),
            createdAt: approval.createdAt,
            expiresAt: approval.expiresAt,
            previewLength: preview.length,
          },
          preview,
          signal,
          current,
        );
        return outcome === 'allowed' ? 'allow-once' : outcome === 'denied' ? 'deny' : 'cancel';
      },
    };
  }
  async dispatch(method: string, p: Record<string, unknown>): Promise<RuntimeReply> {
    try {
      switch (method) {
        case 'decisions.list':
          if (isLocalRoomListQuery(p))
            return {
              result: this.owner.store
                .list(p, p.after ?? '', p.limit ?? 50)
                .map((c) => this.owner.get(c)),
            };
          break;
        case 'decisions.get':
          if (isDecisionRef(p)) return { result: this.owner.get(p) };
          break;
        case 'decisions.preview':
          if (isDecisionChunkQuery(p)) {
            const card = this.owner.get(p);
            if (p.offset > card.previewLength) throw Error('invalid_params');
            return {
              result: {
                ...card,
                offset: p.offset,
                text: this.owner.store.preview(p, p.offset, PREVIEW_CHUNK),
              },
            };
          }
          break;
        case 'decisions.resolve':
          if (isDecisionReply(p)) {
            if (this.#draining) throw Error('runtime_draining');
            const card = await this.owner.resolve(p, p.bindingDigest, p.expectedVersion, p.choice);
            return { result: card };
          }
          break;
        case 'reviews.get':
          if (isReviewChunkQuery(p)) {
            const { view } = await this.reviews.read(p);
            if (p.version !== undefined && view.version !== p.version)
              throw Error('review_conflict');
            const preview = JSON.stringify(view);
            return {
              result: {
                workspaceId: p.workspaceId,
                roomId: p.roomId,
                version: view.version,
                offset: p.offset,
                length: preview.length,
                text: preview.slice(p.offset, p.offset + PREVIEW_CHUNK),
              },
            };
          }
          break;
        case 'reviews.result':
          if (isDecisionRef(p)) return { result: { ...p, applied: this.reviews.applied(p) } };
          break;
        case 'reviews.continue':
          if (isContinuation(p)) {
            if (this.#draining) throw Error('runtime_draining');
            return { result: await this.reviews.request(p) };
          }
          break;
        default:
          return { error: { code: 'method_not_found' } };
      }
      return { error: { code: 'invalid_params' } };
    } catch (e) {
      return {
        error: {
          code: e instanceof Error && errors.has(e.message) ? e.message : 'runtime_failure',
        },
      };
    }
  }
  drain() {
    this.#draining = true;
    return Promise.all([this.reviews.drain(), this.owner.joinChecks()]);
  }
}
