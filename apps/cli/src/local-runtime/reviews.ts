import { reviewDecisionId } from '@runnets/application';
import { digest, ownerPreview } from './decision-preview.js';
import type {
  ChatReviewService,
  OwnerDecision,
  OwnerDecisionRef,
  RuntimeOwnerDecisions,
  ReviewSnapshot,
} from '@runnets/application';
import type { LocalContinuation, LocalReviewSnapshot, LocalRoomScope } from '@runnets/contracts';

function project(scope: LocalRoomScope, s: ReviewSnapshot): LocalReviewSnapshot {
  if (s.roomId !== scope.roomId) throw Error('unknown_run');
  return {
    workspaceId: scope.workspaceId,
    roomId: scope.roomId,
    runId: s.taskRunId,
    version: digest(s.version),
    taskStatus: s.taskStatus,
    turnStatus: s.turnStatus,
    taskVersion: s.taskVersion,
    mode: s.mode,
    canAcknowledge: s.canAcknowledge,
    globalPendingEffects: s.globalPendingEffects,
    relatedPendingEffects: s.relatedPendingEffects,
    effects: s.effects
      .filter((e) => e.taskRunId === s.taskRunId)
      .map(({ id, taskRunId, attemptId, tool, outcome }) => ({
        id,
        taskRunId,
        attemptId,
        tool,
        outcome,
      })),
  };
}
export class RuntimeReviews {
  readonly #service: ChatReviewService;
  readonly #owner: RuntimeOwnerDecisions;
  readonly #closing = new AbortController();
  readonly #jobs = new Map<string, Promise<void>>();
  #jobFailure: Error | null = null;
  constructor(service: ChatReviewService, owner: RuntimeOwnerDecisions) {
    this.#service = service;
    this.#owner = owner;
  }
  async read(scope: LocalRoomScope) {
    const result = await this.#service.reviewRoom(scope.workspaceId, scope.roomId);
    if (!result.ok) throw Error(result.error.code);
    return { raw: result.value, view: project(scope, result.value) };
  }
  async request(q: LocalContinuation): Promise<OwnerDecision> {
    const { workspaceId, roomId, runId, requestId, reviewVersion, reason } = q;
    const ref = {
      workspaceId,
      roomId,
      runId,
      decisionId: reviewDecisionId(workspaceId, requestId, digest),
    };
    const existing = () => {
      const card = this.#owner.store.find(ref);
      if (!card) {
        if (this.#owner.store.has(ref.decisionId) || this.#service.hasRequest(requestId))
          throw Error('request_conflict');
        return null;
      }
      const preview = JSON.parse(this.#owner.store.preview(ref)!) as {
        reason: string;
        snapshot: LocalReviewSnapshot;
      };
      if (preview.reason !== reason || preview.snapshot.version !== reviewVersion)
        throw Error('request_conflict');
      return this.#owner.get(ref);
    };
    const previous = existing();
    if (previous) return previous;
    const { raw, view } = await this.read(q);
    if (view.runId !== runId || !view.canAcknowledge) throw Error('review_unavailable');
    if (view.version !== reviewVersion) throw Error('review_conflict');
    const preview = ownerPreview({ mode: 'text_only', requestId, snapshot: view, reason });
    const createdAt = this.#owner.now();
    const card: OwnerDecision = {
      ...ref,
      kind: 'continue-text-only',
      bindingDigest: digest(preview),
      status: 'pending',
      version: 1,
      createdAt,
      expiresAt: createdAt + 300000,
      previewLength: preview.length,
    };
    const raced = existing();
    if (raced) return raced;
    if (this.#jobs.has(runId)) throw Error('decision_pending');
    const signal = this.#closing.signal;
    const input = { workspaceId, taskRunId: runId, requestId, reviewVersion: raw.version, reason };
    const wait = this.#owner.open(
      card,
      preview,
      signal,
      async () => {
        const current = await this.read(q);
        return (
          current.raw.version === raw.version &&
          current.view.canAcknowledge &&
          current.view.runId === runId
        );
      },
      (insert) => this.#service.reserve(input, roomId, card.decisionId, insert),
    );
    // Only this request's live continuation owns the full raw version. Restart never resumes it.
    const job = wait.then(async (outcome) => {
      if (outcome !== 'allowed') return;
      // The scoped receipt independently records successful application; an expected refusal writes none.
      await this.#service.acknowledge(
        input,
        {
          confirm: (snapshot) =>
            Promise.resolve(
              snapshot.version === raw.version &&
                snapshot.roomId === roomId &&
                snapshot.taskRunId === runId &&
                !signal.aborted &&
                this.#owner.now() >= createdAt &&
                this.#owner.now() < card.expiresAt,
            ),
        },
        signal,
        card.decisionId,
      );
    });
    const supervised = job
      .catch((cause: unknown) => {
        this.#jobFailure = new Error('review_settlement_unknown', { cause });
      })
      .finally(() => this.#jobs.delete(runId));
    this.#jobs.set(runId, supervised);
    return card;
  }
  applied(ref: OwnerDecisionRef) {
    const card = this.#owner.get(ref);
    if (card.kind !== 'continue-text-only') throw Error('unknown_decision');
    if (card.status !== 'allowed') return false;
    const preview = JSON.parse(this.#owner.store.preview(ref)!) as {
      snapshot: LocalReviewSnapshot;
      requestId: string;
      reason: string;
    };
    const receipt = this.#service.receipt(
      ref.workspaceId,
      ref.roomId,
      ref.runId,
      preview.requestId,
    );
    return (
      receipt !== null &&
      digest(receipt.observedVersion) === preview.snapshot.version &&
      receipt.reason === preview.reason
    );
  }
  async drain() {
    this.#closing.abort();
    await Promise.all(this.#jobs.values());
    if (this.#jobFailure) throw this.#jobFailure;
  }
}
