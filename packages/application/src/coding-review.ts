import {
  codingFailure,
  ok,
  codingReviewCurrent,
  codingReviewFindingValid,
  type CodingTestEvidence,
  type CodingTask,
  type Changeset,
  type CodingReviewRequest,
  type CodingReviewBinding,
  type CodingReviewVerdict,
  type CodingResult,
} from '@runnets/domain';
export interface CodingReviewTransaction {
  task(id: string): CodingTask | null;
  changeset(hash: string): Changeset | null;
  reviewRequest(id: string): CodingReviewRequest | null;
  putReviewRequest(request: CodingReviewRequest): void;
  putReviewVerdict(requestId: string, verdict: CodingReviewVerdict): void;
  reviewVerdict(requestId: string): CodingReviewVerdict | null;
  evidenceHashes(taskId: string): readonly string[];
  evidenceTreesMatch(taskId: string, afterTreeHash: string): boolean;
  evidence(taskId: string): readonly CodingTestEvidence[];
}
export interface CodingReviewStore {
  atomic<T>(work: (tx: CodingReviewTransaction) => T): T;
}
export interface CodingReviewOwnerPort {
  confirm(
    preview: Readonly<{ request: CodingReviewRequest; changeset: Changeset }>,
  ): Promise<boolean>;
}
export interface CodingReviewerPort {
  review(
    input: Readonly<{
      request: CodingReviewRequest;
      changeset: Changeset;
      evidence: readonly CodingTestEvidence[];
    }>,
  ): Promise<Pick<CodingReviewVerdict, 'verdict' | 'findings' | 'summary'>>;
}
/** Immutable artifact handoff. No conversation history or executable tools enter this port. */
export class CodingReviewService {
  readonly #store: CodingReviewStore;
  readonly #admit: (task: CodingTask) => boolean;
  constructor(store: CodingReviewStore, admit: (task: CodingTask) => boolean) {
    this.#store = store;
    this.#admit = admit;
  }
  async request(
    input: Readonly<{
      id: string;
      workspaceId: string;
      taskId: string;
      changesetHash: string;
      contextGrant?: readonly string[];
    }>,
    owner: CodingReviewOwnerPort,
  ): Promise<CodingResult<CodingReviewRequest>> {
    const i = structuredClone(input);
    if (
      !i.id ||
      i.contextGrant?.some((text) => typeof text !== 'string' || text.length > 131072) ||
      (i.contextGrant?.join('').length ?? 0) > 524288
    )
      return codingFailure('invalid_input');
    const prepared = this.#store.atomic((tx) => {
      const task = tx.task(i.taskId),
        changeset = tx.changeset(i.changesetHash);
      if (
        !task ||
        task.status !== 'reserved' ||
        task.workspaceId !== i.workspaceId ||
        !this.#admit(task) ||
        !changeset ||
        changeset.taskId !== task.id
      )
        return null;
      const request: CodingReviewRequest = {
        id: i.id,
        workspaceId: i.workspaceId,
        reviewRoomId: task.reviewRoomId,
        reviewerBotId: task.reviewBotId,
        status: 'requested',
        contextGrant: i.contextGrant ?? [],
        binding: {
          taskId: task.id,
          changesetHash: changeset.hash,
          baseCommit: changeset.baseCommit,
          afterTreeHash: changeset.afterTreeHash,
          testEvidenceHashes: [...tx.evidenceHashes(task.id)],
        },
      };
      return { request, changeset };
    });
    if (!prepared) return codingFailure('coding_denied');
    if (!(await owner.confirm(structuredClone(prepared))))
      return codingFailure('approval_required');
    return this.#store.atomic((tx) => {
      const task = tx.task(i.taskId),
        changeset = tx.changeset(i.changesetHash);
      if (tx.reviewRequest(i.id)) return codingFailure('request_conflict');
      if (
        !task ||
        task.status !== 'reserved' ||
        !this.#admit(task) ||
        !changeset ||
        task.reviewRoomId !== prepared.request.reviewRoomId ||
        task.reviewBotId !== prepared.request.reviewerBotId ||
        !codingReviewCurrent(prepared.request.binding, changeset, tx.evidenceHashes(task.id))
      )
        return codingFailure('project_changed');
      tx.putReviewRequest(prepared.request);
      return ok(prepared.request);
    });
  }
  /** Compare the selected stored snapshot and evidence without consulting a live Git tree. */
  inspectBinding(binding: CodingReviewBinding) {
    return this.#store.atomic((tx) => {
      const changeset = tx.changeset(binding.changesetHash);
      const hashes = tx.evidenceHashes(binding.taskId);
      return {
        current: changeset !== null && codingReviewCurrent(binding, changeset, hashes),
        tests:
          JSON.stringify(binding.testEvidenceHashes) !== JSON.stringify(hashes)
            ? 'changed'
            : hashes.length === 0
              ? 'none'
              : tx.evidenceTreesMatch(binding.taskId, binding.afterTreeHash)
                ? 'matches_snapshot'
                : 'different_snapshot',
      } as const;
    });
  }
  facts(id: string) {
    return this.#store.atomic((tx) => ({
      request: tx.reviewRequest(id),
      verdict: tx.reviewVerdict(id),
    }));
  }
  async dispatch(
    requestId: string,
    reviewer: CodingReviewerPort,
  ): Promise<CodingResult<CodingReviewVerdict>> {
    const input = this.#store.atomic((tx) => {
      const request = tx.reviewRequest(requestId);
      const task = request ? tx.task(request.binding.taskId) : null;
      const changeset = request ? tx.changeset(request.binding.changesetHash) : null;
      if (
        !request ||
        request.status !== 'requested' ||
        !task ||
        task.status !== 'reserved' ||
        !this.#admit(task) ||
        !changeset ||
        !codingReviewCurrent(request.binding, changeset, tx.evidenceHashes(task.id))
      )
        return null;
      const dispatching = { ...request, status: 'dispatching' as const };
      tx.putReviewRequest(dispatching);
      return { request: dispatching, changeset, evidence: tx.evidence(task.id) };
    });
    if (!input) return codingFailure('coding_denied');
    try {
      const response = await reviewer.review(structuredClone(input));
      const result = this.record(requestId, {
        ...response,
        id: requestId + '-verdict',
        binding: input.request.binding,
        reviewerBotId: input.request.reviewerBotId,
        reviewRoomId: input.request.reviewRoomId,
      });
      if (result.ok) return result;
    } catch {
      /* Preserve the dispatched request for reconciliation. */
    }
    this.#store.atomic((tx) => {
      const request = tx.reviewRequest(requestId);
      if (request?.status === 'dispatching')
        tx.putReviewRequest({ ...request, status: 'uncertain' });
    });
    return codingFailure('recovery_required');
  }
  record(requestId: string, verdict: CodingReviewVerdict): CodingResult<CodingReviewVerdict> {
    const value = structuredClone(verdict);
    return this.#store.atomic((tx) => {
      const request = tx.reviewRequest(requestId),
        changeset = tx.changeset(value.binding.changesetHash);
      const task = request ? tx.task(request.binding.taskId) : null;
      if (
        !request ||
        !['requested', 'dispatching'].includes(request.status) ||
        !task ||
        !this.#admit(task) ||
        !changeset ||
        value.reviewRoomId !== request.reviewRoomId ||
        value.reviewerBotId !== request.reviewerBotId ||
        JSON.stringify(value.binding) !== JSON.stringify(request.binding) ||
        !codingReviewCurrent(value.binding, changeset, tx.evidenceHashes(task.id)) ||
        !['approve', 'changes_requested', 'insufficient_context'].includes(value.verdict) ||
        !value.summary.trim() ||
        value.summary.length > 131072 ||
        value.findings.length > 100 ||
        !value.findings.every((f) => codingReviewFindingValid(f, changeset))
      )
        return codingFailure('coding_denied');
      tx.putReviewVerdict(requestId, value);
      tx.putReviewRequest({ ...request, status: 'completed' });
      return ok(value);
    });
  }
}
