import {
  codingFailure,
  ok,
  codingReviewCurrent,
  codingReviewFindingValid,
  type CodingTask,
  type Changeset,
  type CodingReviewRequest,
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
}
export interface CodingReviewStore {
  atomic<T>(work: (tx: CodingReviewTransaction) => T): T;
}
export interface CodingReviewOwnerPort {
  confirm(
    preview: Readonly<{ request: CodingReviewRequest; changeset: Changeset }>,
  ): Promise<boolean>;
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
  record(requestId: string, verdict: CodingReviewVerdict): CodingResult<CodingReviewVerdict> {
    const value = structuredClone(verdict);
    return this.#store.atomic((tx) => {
      const request = tx.reviewRequest(requestId),
        changeset = tx.changeset(value.binding.changesetHash);
      const task = request ? tx.task(request.binding.taskId) : null;
      if (
        !request ||
        request.status !== 'requested' ||
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
