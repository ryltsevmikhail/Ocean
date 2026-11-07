import type {
  ChatReviewService,
  CodingApprovalOwnerPort,
  OwnerDecisionStore,
  ServiceCallConfirmation,
  DecisionOutcome,
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
import { LEGACY_WIRE_CONTEXT, type RuntimeWireContext } from './client-compatibility.js';
import { digest, ownerPreview } from './decision-preview.js';
import { RuntimeReviews } from './reviews.js';
import type { RuntimeReply } from './queries.js';
const errors = new Set([
  'invalid_params',
  'unknown_decision',
  'unknown_run',
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
  'service_confirmation_upgrade_required',
  'client_upgrade_required',
]);
export class RuntimeDecisions {
  readonly owner: RuntimeOwnerDecisions;
  readonly reviews: RuntimeReviews;
  #draining = false;
  readonly #inFlight = new Set<Promise<RuntimeReply>>();
  constructor(store: OwnerDecisionStore, reviews: ChatReviewService, now: () => number = Date.now) {
    this.owner = new RuntimeOwnerDecisions(store, now);
    this.reviews = new RuntimeReviews(reviews, this.owner);
  }
  async service(
    operation: ServiceCallConfirmation,
    signal: AbortSignal,
    current: () => Promise<boolean>,
  ): Promise<DecisionOutcome> {
    if (this.#draining) return 'cancelled';
    const r = operation.request,
      preview = ownerPreview(operation),
      createdAt = this.owner.now();
    return this.owner.open(
      {
        workspaceId: r.workspaceId,
        roomId: r.roomId,
        runId: r.taskRunId,
        decisionId:
          'service-' +
          digest(
            JSON.stringify([r.workspaceId, r.roomId, r.taskRunId, r.attemptId, r.invocationId]),
          ),
        kind: 'service-call',
        version: 1,
        status: 'pending',
        bindingDigest: digest(preview),
        previewLength: preview.length,
        createdAt,
        expiresAt: createdAt + 300000,
      },
      preview,
      signal,
      current,
    );
  }
  coding(turn: ChatTurn, signal: AbortSignal): CodingApprovalOwnerPort {
    return {
      decideRead: async (operation, current) => {
        const r = operation.request;
        if (
          this.#draining ||
          r.workspaceId !== turn.workspaceId ||
          r.roomId !== turn.roomId ||
          r.runId !== turn.taskRunId ||
          r.botId !== turn.bot.id ||
          r.taskId !== turn.codingTaskId
        )
          return 'cancel';
        const preview = ownerPreview(operation),
          createdAt = this.owner.now();
        const outcome = await this.owner.open(
          {
            workspaceId: r.workspaceId,
            roomId: r.roomId,
            runId: r.runId,
            decisionId:
              'read-' +
              digest(JSON.stringify([r.runId, r.attemptId, r.invocationId, r.operationDigest])),
            kind: 'project-read',
            version: 1,
            status: 'pending',
            bindingDigest: digest(preview),
            createdAt,
            expiresAt: createdAt + 300000,
            previewLength: preview.length,
          },
          preview,
          signal,
          current,
        );
        return outcome === 'allowed' ? 'allow-once' : outcome === 'denied' ? 'deny' : 'cancel';
      },
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
  dispatch(
    method: string,
    p: Record<string, unknown>,
    context = LEGACY_WIRE_CONTEXT,
  ): Promise<RuntimeReply> {
    if (!['reviews.get', 'reviews.continue', 'decisions.resolve'].includes(method))
      return this.#dispatch(method, p, context);
    if (this.#draining) return Promise.resolve({ error: { code: 'runtime_draining' } });
    const job = this.#dispatch(method, p, context);
    this.#inFlight.add(job);
    void job.finally(() => this.#inFlight.delete(job));
    return job;
  }
  async #dispatch(
    method: string,
    p: Record<string, unknown>,
    context: RuntimeWireContext,
  ): Promise<RuntimeReply> {
    const compatible = (card: ReturnType<RuntimeOwnerDecisions['get']>) => {
      if (card.kind === 'project-setup' && !context.codingWorkspace)
        throw Error('client_upgrade_required');
      if (card.kind === 'project-read' && (!context.roomTasks || !context.addressedHistory))
        throw Error('client_upgrade_required');
      if (card.kind === 'service-call' && !context.serviceConfirmations)
        throw Error('service_confirmation_upgrade_required');
      return card;
    };
    try {
      switch (method) {
        case 'decisions.list':
          if (isLocalRoomListQuery(p))
            return {
              result: this.owner.store
                .list(
                  p,
                  p.after ?? '',
                  p.limit ?? 50,
                  context.codingWorkspace ? undefined : 'project-setup',
                )
                .map((c) => compatible(this.owner.get(c))),
            };
          break;
        case 'decisions.get':
          if (isDecisionRef(p)) return { result: compatible(this.owner.get(p)) };
          break;
        case 'decisions.preview':
          if (isDecisionChunkQuery(p)) {
            const card = compatible(this.owner.get(p));
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
            const current = compatible(this.owner.get(p));
            if (current.kind === 'project-setup' && current.version !== p.expectedVersion)
              throw Error('version_conflict');
            const card = await this.owner.resolve(p, p.bindingDigest, p.expectedVersion, p.choice);
            return { result: card };
          }
          break;
        case 'reviews.get':
          if (isReviewChunkQuery(p)) {
            const { view } = await this.reviews.read(p, p.runId);
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
  async drain() {
    this.#draining = true;
    await Promise.all([this.reviews.drain(), ...this.#inFlight, this.owner.joinChecks()]);
    await this.reviews.drain();
  }
}
