import { randomUUID } from 'node:crypto';
import {
  ModelCodingReviewer,
  admitRoomModelTransfer,
  freezeModelActivation,
  type CodingReviewOwnerPort,
  type ConversationTransaction,
  type ProviderActivationPort,
  type RuntimeOwnerDecisions,
} from '@runnets/application';
import {
  codingFailure,
  taskRunId,
  type CodingReviewBinding,
  type CodingTask,
  type BotModelBinding,
  type ModelActivationSnapshot,
} from '@runnets/domain';
import {
  isCodingReviewStatus,
  type CodingReviewQuery,
  type CodingReviewStatus,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { digest, ownerPreview } from './decision-preview.js';
import { ProjectPreCardRefusal } from './project-pre-card-refusal.js';

type ReviewRuntime = Pick<Runtime, 'codingReview' | 'coding' | 'conversationStore' | 'service'>;
export const reviewReference = (q: CodingReviewQuery) => {
  const key = 'coding-review-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
  return { workspaceId: q.workspaceId, roomId: q.roomId, runId: key, decisionId: key };
};

/** Exact review bindings and durable reads; the setup lane owns the waiter and job. */
export class ProjectReview {
  readonly runtime: ReviewRuntime;
  readonly owner: RuntimeOwnerDecisions;
  readonly resolver: ProviderActivationPort;
  constructor(
    runtime: ReviewRuntime,
    owner: RuntimeOwnerDecisions,
    resolver: ProviderActivationPort,
  ) {
    this.runtime = runtime;
    this.owner = owner;
    this.resolver = resolver;
  }
  #task(q: CodingReviewQuery) {
    const inspected = this.runtime.coding.inspect(q.workspaceId, q.taskId);
    if (!inspected.ok) throw Error(inspected.error.code);
    const task = inspected.value;
    if (task.reviewRoomId !== q.roomId || !this.runtime.conversationStore)
      throw Error('coding_denied');
    return task;
  }
  #bound(q: CodingReviewQuery, task: CodingTask, tx: ConversationTransaction) {
    const workspace = tx.workspace(),
      room = tx.room(q.roomId),
      bot = tx.bot(task.reviewBotId);
    if (
      workspace?.id !== q.workspaceId ||
      workspace.root !== task.projectRoot ||
      room?.workspaceId !== q.workspaceId ||
      !(room.kind === 'direct'
        ? room.botId === task.reviewBotId
        : room.botIds.includes(task.reviewBotId)) ||
      !bot ||
      bot.workspaceId !== q.workspaceId
    )
      throw Error('coding_denied');
    return bot;
  }
  #activation(q: CodingReviewQuery) {
    const task = this.#task(q);
    const admission = this.runtime.coding.authorize({
      workspaceId: q.workspaceId,
      roomId: q.roomId,
      taskId: q.taskId,
      botId: task.reviewBotId,
      policyVersion: task.policyVersion,
      capability: 'changeset_read',
    });
    if (!admission.ok) throw Error(admission.error.code);
    return this.runtime.conversationStore!.atomic((tx) => {
      const bot = this.#bound(q, task, tx);
      const binding = tx.modelBinding(bot.id);
      if (!binding || binding.modelId !== bot.model) throw Error('provider_unavailable');
      const at = new Date(this.owner.now()).toISOString();
      const resolved = this.resolver.resolve({ bot, binding }, at);
      if (!resolved.ok) throw Error(resolved.error.code);
      const snapshot = freezeModelActivation(resolved.value.snapshot);
      const transfer = admitRoomModelTransfer(tx, q.roomId, snapshot.identity);
      if (!transfer.ok) throw new ProjectPreCardRefusal(transfer.error.code);
      if (
        snapshot.identity.providerId !== bot.provider ||
        snapshot.identity.modelId !== bot.model ||
        resolved.value.provider.id !== bot.provider ||
        !resolved.value.provider.models.includes(bot.model) ||
        !resolved.value.provider.capabilities.streaming ||
        !snapshot.capabilities.streaming
      )
        throw Error('provider_unavailable');
      return {
        provider: resolved.value.provider,
        snapshot,
        safe: {
          projectRoot: task.projectRoot,
          policyVersion: task.policyVersion,
          roomPolicyRevision: tx.roomModelPolicy(q.roomId)!.revision,
          reviewerBotId: bot.id,
          reviewerProfileVersion: bot.profileVersion,
          modelBinding: binding,
          activation: snapshot.identity,
          capabilities: snapshot.capabilities,
          limits: { ...snapshot.limits, maxModelRequests: 1 },
        },
      };
    });
  }
  #preview(q: CodingReviewQuery, binding: CodingReviewBinding, safe: SafeActivation) {
    return { operation: 'review' as const, request: q, binding, ...safe };
  }
  #current(q: CodingReviewQuery, preview: ReviewPreview) {
    try {
      const activation = this.#activation(q);
      return ownerPreview(this.#preview(q, preview.binding, activation.safe)) ===
        ownerPreview(preview) && this.runtime.codingReview?.inspectBinding(preview.binding).current
        ? activation
        : null;
    } catch {
      return null;
    }
  }
  pending(decision: CodingReviewStatus['decision'], value: unknown): CodingReviewStatus {
    const p = value as ReviewPreview;
    const { current, tests } = this.runtime.codingReview!.inspectBinding(p.binding);
    return { decision, state: 'pending', stale: !current, tests, verdict: null };
  }
  existing(q: CodingReviewQuery, active: (id: string) => boolean): CodingReviewStatus | null {
    const task = this.#task(q);
    this.runtime.conversationStore!.atomic((tx) => this.#bound(q, task, tx));
    const service = this.runtime.codingReview;
    if (!service) throw Error('review_unavailable');
    const ref = reviewReference(q),
      stored = this.owner.store.find(ref);
    if (!stored) {
      if (this.owner.store.has(ref.decisionId) || service.facts(ref.decisionId).request)
        throw Error('request_conflict');
      return null;
    }
    const text = this.owner.store.preview(ref);
    if (
      !text ||
      stored.kind !== 'project-setup' ||
      digest(text) !== stored.bindingDigest ||
      text.length !== stored.previewLength
    )
      throw Error('review_unavailable');
    const preview = JSON.parse(text) as ReviewPreview;
    if (preview.operation !== 'review' || ownerPreview(preview.request) !== ownerPreview(q))
      throw Error('request_conflict');
    const decision = this.owner.get(ref);
    const { request, verdict } = service.facts(ref.decisionId);
    if (
      (request &&
        (request.workspaceId !== q.workspaceId ||
          request.reviewRoomId !== q.roomId ||
          request.reviewerBotId !== preview.reviewerBotId ||
          ownerPreview(request.binding) !== ownerPreview(preview.binding) ||
          decision.status !== 'allowed')) ||
      (request?.status === 'completed') !== (verdict !== null) ||
      (verdict &&
        (verdict.id !== ref.decisionId + '-verdict' ||
          verdict.reviewRoomId !== q.roomId ||
          verdict.reviewerBotId !== preview.reviewerBotId ||
          ownerPreview(verdict.binding) !== ownerPreview(preview.binding)))
    )
      throw Error('review_unavailable');
    const live = active(ref.decisionId);
    const state =
      decision.status === 'pending'
        ? 'pending'
        : decision.status !== 'allowed'
          ? 'no_review'
          : request?.status === 'completed'
            ? 'completed'
            : request?.status === 'uncertain' || (request?.status === 'dispatching' && !live)
              ? 'outcome_unknown'
              : live && request
                ? request.status
                : 'unconfirmed';
    const { current, tests } = service.inspectBinding(preview.binding);
    const stale =
      !current ||
      task.status !== 'reserved' ||
      task.projectRoot !== preview.projectRoot ||
      task.policyVersion !== preview.policyVersion ||
      task.reviewBotId !== preview.reviewerBotId;
    const value = { decision, state, stale, tests, verdict };
    if (!isCodingReviewStatus(value)) throw Error('review_unavailable');
    return value;
  }
  async run(
    q: CodingReviewQuery,
    signal: AbortSignal,
    confirm: (value: unknown, current: () => Promise<boolean>) => Promise<boolean>,
    uncertain: () => void,
  ) {
    const service = this.runtime.codingReview;
    if (!service) return codingFailure('coding_denied');
    const ref = reviewReference(q);
    const admitted = this.#activation(q).safe;
    let preview: ReviewPreview | undefined;
    const owner: CodingReviewOwnerPort = {
      confirm: async ({ request }) => {
        if (request.reviewerBotId !== admitted.reviewerBotId || request.reviewRoomId !== q.roomId)
          return false;
        const pin = this.#preview(q, request.binding, admitted);
        preview = pin;
        return confirm(pin, () => Promise.resolve(this.#current(q, pin) !== null));
      },
    };
    const requested = await service.request(
      { id: ref.decisionId, workspaceId: q.workspaceId, taskId: q.taskId, changesetHash: q.hash },
      owner,
    );
    if (!requested.ok) return requested;
    const pin = preview!;
    const activation = this.#current(q, pin);
    if (!activation || signal.aborted) return codingFailure('project_changed');
    let settled = false;
    const result = await service.dispatch(
      ref.decisionId,
      new ModelCodingReviewer({
        tasks: this.runtime.service,
        provider: activation.provider,
        model: activation.snapshot.identity.modelId,
        activation: { ...activation.snapshot, limits: pin.limits },
        nextRunId: () => taskRunId('tr_' + randomUUID().replaceAll('-', '')),
        signal,
        emit: () => {},
        onSettled: () => {
          settled = true;
        },
        authorizeModelDispatch: () => {
          if (signal.aborted || !this.#current(q, pin)) return false;
          const card = this.owner.store.find(ref);
          return card?.status === 'allowed' && card.bindingDigest === digest(ownerPreview(pin));
        },
      }),
    );
    if (!result.ok && result.error.code === 'recovery_required' && !settled) uncertain();
    return result;
  }
}

type SafeActivation = {
  projectRoot: string;
  policyVersion: number;
  roomPolicyRevision: number;
  reviewerBotId: string;
  reviewerProfileVersion: number;
  modelBinding: BotModelBinding;
  activation: ModelActivationSnapshot['identity'];
  capabilities: ModelActivationSnapshot['capabilities'];
  limits: ModelActivationSnapshot['limits'];
};
type ReviewPreview = {
  operation: 'review';
  request: CodingReviewQuery;
  binding: CodingReviewBinding;
} & SafeActivation;
