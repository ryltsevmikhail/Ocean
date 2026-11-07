import type { CodingApplyPreview, RuntimeOwnerDecisions } from '@runnets/application';
import type { CodingApplyReceipt } from '@runnets/domain';
import {
  isCodingApplyStatus,
  type CodingApplyQuery,
  type CodingApplyStatus,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { codingOwnerTask } from './coding-reads.js';
import { digest, ownerPreview } from './decision-preview.js';

type ApplyRuntime = Pick<
  Runtime,
  'coding' | 'codingApply' | 'codingReview' | 'conversations' | 'conversationStore'
>;
export const applyReference = (q: CodingApplyQuery) => {
  const id = 'coding-apply-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
  return { workspaceId: q.workspaceId, roomId: q.roomId, runId: id, decisionId: id };
};

function preview(q: CodingApplyQuery, { task, changeset, verdict }: CodingApplyPreview) {
  return {
    operation: 'apply' as const,
    request: q,
    projectRoot: task.projectRoot,
    fileCount: changeset.files.length,
    verdict: {
      id: verdict.id,
      reviewerBotId: verdict.reviewerBotId,
      reviewRoomId: verdict.reviewRoomId,
      verdict: verdict.verdict,
      binding: verdict.binding,
    },
  };
}
function summary(receipt: CodingApplyReceipt) {
  const { id, taskId, changesetHash, expectedBase, reviewRequestId, status, files } = receipt;
  return {
    id,
    taskId,
    changesetHash,
    expectedBase,
    reviewRequestId,
    status,
    fileCount: files.length,
    completedFiles: files.filter((f) => f.status === 'completed').length,
    uncertainFiles: files.filter((f) => f.status === 'uncertain').length,
  };
}

/** Route one exact owner decision to the existing application service and its receipt. */
export class ProjectApply {
  readonly runtime: ApplyRuntime;
  readonly owner: RuntimeOwnerDecisions;
  constructor(runtime: ApplyRuntime, owner: RuntimeOwnerDecisions) {
    this.runtime = runtime;
    this.owner = owner;
  }
  #service() {
    if (!this.runtime.codingApply) throw Error('apply_unavailable');
    return this.runtime.codingApply;
  }
  #completedReview(q: CodingApplyQuery, pin: ReturnType<typeof preview>): boolean {
    const facts = this.runtime.codingReview?.facts(q.reviewRequestId);
    const request = facts?.request;
    return (
      request?.status === 'completed' &&
      request.id === q.reviewRequestId &&
      request.workspaceId === q.workspaceId &&
      request.reviewRoomId === pin.verdict.reviewRoomId &&
      request.reviewerBotId === pin.verdict.reviewerBotId &&
      ownerPreview(request.binding) === ownerPreview(pin.verdict.binding)
    );
  }
  existing(q: CodingApplyQuery, active: (id: string) => boolean): CodingApplyStatus | null {
    codingOwnerTask(this.runtime, q);
    const ref = applyReference(q);
    const stored = this.owner.store.find(ref);
    const receipt = this.#service().receipt(ref.decisionId);
    if (!stored) {
      if (this.owner.store.has(ref.decisionId) || receipt) throw Error('request_conflict');
      return null;
    }
    const text = this.owner.store.preview(ref);
    if (
      !text ||
      stored.kind !== 'project-setup' ||
      digest(text) !== stored.bindingDigest ||
      text.length !== stored.previewLength
    )
      throw Error('apply_unavailable');
    const pin = JSON.parse(text) as ReturnType<typeof preview>;
    if (pin.operation !== 'apply' || ownerPreview(pin.request) !== ownerPreview(q))
      throw Error('request_conflict');
    const decision = this.owner.get(ref);
    if (
      receipt &&
      (decision.status !== 'allowed' ||
        receipt.id !== ref.decisionId ||
        receipt.taskId !== q.taskId ||
        receipt.expectedBase !== q.expectedBase ||
        receipt.changesetHash !== q.changesetHash ||
        receipt.reviewRequestId !== q.reviewRequestId ||
        receipt.files.length !== pin.fileCount)
    )
      throw Error('apply_unavailable');
    const state =
      decision.status === 'pending'
        ? 'pending'
        : decision.status !== 'allowed'
          ? 'no_application'
          : receipt === null
            ? 'unconfirmed'
            : receipt.status === 'uncertain' ||
                (receipt.status === 'applying' && !active(ref.decisionId))
              ? 'outcome_unknown'
              : receipt.status;
    const value = { decision, state, receipt: receipt ? summary(receipt) : null };
    if (!isCodingApplyStatus(value)) throw Error('apply_unavailable');
    return value;
  }
  async run(
    q: CodingApplyQuery,
    confirm: (value: unknown, current: () => Promise<boolean>) => Promise<boolean>,
    uncertain: () => void,
  ) {
    const service = this.#service();
    const ref = applyReference(q);
    const input = {
      id: ref.decisionId,
      workspaceId: q.workspaceId,
      ownerRoomId: q.roomId,
      taskId: q.taskId,
      expectedBase: q.expectedBase,
      changesetHash: q.changesetHash,
      reviewRequestId: q.reviewRequestId,
    };
    const result = await service.apply(input, {
      confirm: async (prepared) => {
        const pin = preview(q, prepared);
        if (!this.#completedReview(q, pin)) throw Error('coding_denied');
        const checkScope = () => {
          codingOwnerTask(this.runtime, q);
          return this.#completedReview(q, pin);
        };
        const allowed = await confirm(
          pin,
          async () => checkScope() && (await service.current(input, prepared)) && checkScope(),
        );
        if (!allowed) return false;
        try {
          return checkScope();
        } catch {
          return false;
        }
      },
    });
    if (!result.ok && result.error.code === 'recovery_required') {
      const receipt = service.receipt(input.id);
      if (receipt?.status === 'applying' || receipt?.status === 'uncertain') uncertain();
    }
    return result;
  }
}
