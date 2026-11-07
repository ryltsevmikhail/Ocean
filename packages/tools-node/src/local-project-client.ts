import { createHash } from 'node:crypto';
import {
  CODING_REVIEW_REQUEST,
  CODING_APPLY_REQUEST,
  isCodingApplyQuery,
  isCodingApplyStatus,
  type CodingApplyQuery,
  type CodingApplyStatus,
  isCodingReviewQuery,
  isCodingReviewStatus,
  type CodingReviewQuery,
  type CodingReviewStatus,
  isCodingChangesetCapture,
  isCodingChangesetRead,
  isCodingChangesetSummary,
  isCodingChangesetDiff,
  type CodingChangesetCapture,
  type CodingChangesetRead,
  type CodingChangesetSummary,
  type CodingChangesetDiff,
  isCodingTaskPrepare,
  isCodingTaskPreparation,
  type CodingTaskPrepare,
  type CodingTaskPreparation,
  isCodingTaskReserve,
  isCodingTaskReservation,
  type CodingTaskReserve,
  type CodingTaskReservation,
  LOCAL_CODING_WORKSPACE,
  LOCAL_CODING_WORKSPACE_PAGE,
  isCodingProjectsList,
  isCodingProjectsPage,
  isCodingTasksList,
  isCodingTasksPage,
  type CodingProjectsList,
  type CodingProjectsPage,
  type CodingTasksList,
  type CodingTasksPage,
  type LocalRuntimeIdentity,
} from '@runnets/contracts';
import { readPanelChunks } from './local-panel-client.js';
import { validatedParams } from './local-room-client.js';

export interface LocalProjectClient {
  applyCodingChangeset(input: CodingApplyQuery): Promise<CodingApplyStatus>;
  requestCodingReview(input: CodingReviewQuery): Promise<CodingReviewStatus>;
  captureCodingChangeset(input: CodingChangesetCapture): Promise<CodingChangesetSummary>;
  readCodingChangeset(input: CodingChangesetRead): Promise<CodingChangesetDiff>;
  prepareCodingTask(input: CodingTaskPrepare): Promise<CodingTaskPreparation>;
  reserveCodingTask(input: CodingTaskReserve): Promise<CodingTaskReservation>;
  listCodingProjects(input: CodingProjectsList): Promise<CodingProjectsPage>;
  listCodingTasks(input: CodingTasksList): Promise<CodingTasksPage>;
}
function matchesPage(
  q: CodingProjectsList,
  v: { workspaceId: string; nextAfter: string | null },
  rows: readonly { id: string }[],
) {
  const limit = q.limit ?? LOCAL_CODING_WORKSPACE_PAGE;
  let after = Buffer.from(q.after ?? '');
  return (
    v.workspaceId === q.workspaceId &&
    rows.length <= limit &&
    (v.nextAfter === null || rows.length === limit) &&
    rows.every((r) => {
      // Match SQLite BINARY ordering, including supplementary characters in task IDs.
      const key = Buffer.from(r.id);
      if (Buffer.compare(key, after) <= 0) return false;
      after = key;
      return true;
    })
  );
}
export function localProjectClient(
  send: (method: string, params: unknown, timeout?: number) => Promise<unknown>,
  identity: LocalRuntimeIdentity,
): LocalProjectClient {
  const requireFeature = () => {
    if (!identity.capabilities.includes(LOCAL_CODING_WORKSPACE))
      throw Error('client_upgrade_required');
  };
  return {
    async applyCodingChangeset(input) {
      requireFeature();
      const q = validatedParams(input, isCodingApplyQuery);
      const v = await send(CODING_APPLY_REQUEST, q, 30000);
      const id =
        'coding-apply-' +
        createHash('sha256')
          .update(JSON.stringify([q.workspaceId, q.requestId]))
          .digest('hex');
      if (
        !isCodingApplyStatus(v) ||
        v.decision.workspaceId !== q.workspaceId ||
        v.decision.roomId !== q.roomId ||
        v.decision.runId !== id ||
        v.decision.decisionId !== id ||
        (v.receipt &&
          (v.receipt.taskId !== q.taskId ||
            v.receipt.expectedBase !== q.expectedBase ||
            v.receipt.changesetHash !== q.changesetHash ||
            v.receipt.reviewRequestId !== q.reviewRequestId))
      )
        throw Error('invalid_frame');
      return v;
    },
    async requestCodingReview(input) {
      requireFeature();
      const q = validatedParams(input, isCodingReviewQuery);
      const v = await send(CODING_REVIEW_REQUEST, q);
      const id =
        'coding-review-' +
        createHash('sha256')
          .update(JSON.stringify([q.workspaceId, q.requestId]))
          .digest('hex');
      if (
        !isCodingReviewStatus(v) ||
        v.decision.workspaceId !== q.workspaceId ||
        v.decision.roomId !== q.roomId ||
        v.decision.runId !== id ||
        v.decision.decisionId !== id ||
        (v.verdict &&
          (v.verdict.id !== id + '-verdict' ||
            v.verdict.reviewRoomId !== q.roomId ||
            v.verdict.binding.taskId !== q.taskId ||
            v.verdict.binding.changesetHash !== q.hash))
      )
        throw Error('invalid_frame');
      return v;
    },
    async captureCodingChangeset(input) {
      requireFeature();
      const q = validatedParams(input, isCodingChangesetCapture);
      const v = await send('coding.changesets.capture', q, 30000);
      if (
        !isCodingChangesetSummary(v) ||
        v.workspaceId !== q.workspaceId ||
        v.roomId !== q.roomId ||
        v.taskId !== q.taskId
      )
        throw Error('invalid_frame');
      return v;
    },
    async readCodingChangeset(input) {
      requireFeature();
      const q = validatedParams(input, isCodingChangesetRead);
      const v: unknown = JSON.parse(await readPanelChunks(send, 'coding.changesets.read', q));
      if (
        !isCodingChangesetDiff(v) ||
        v.workspaceId !== q.workspaceId ||
        v.roomId !== q.roomId ||
        v.taskId !== q.taskId ||
        v.hash !== q.hash
      )
        throw Error('invalid_frame');
      return v;
    },
    async prepareCodingTask(input) {
      requireFeature();
      const q = validatedParams(input, isCodingTaskPrepare);
      const v = await send('coding.tasks.prepare', q);
      if (
        !isCodingTaskPreparation(v) ||
        (v.decision &&
          (v.decision.workspaceId !== q.workspaceId ||
            v.decision.roomId !== q.roomId ||
            v.decision.runId !== v.decision.decisionId ||
            v.decision.decisionId !==
              'prepare-' +
                createHash('sha256')
                  .update(JSON.stringify([q.workspaceId, q.requestId]))
                  .digest('hex'))) ||
        (v.worktree && (v.worktree.taskId !== q.taskId || v.worktree.workspaceId !== q.workspaceId))
      )
        throw Error('invalid_frame');
      return v;
    },
    async reserveCodingTask(input) {
      requireFeature();
      const q = validatedParams(input, isCodingTaskReserve);
      const v = await send('coding.tasks.reserve', q);
      if (
        !isCodingTaskReservation(v) ||
        v.decision.workspaceId !== q.workspaceId ||
        v.decision.roomId !== q.ownerRoomId ||
        v.decision.runId !== v.decision.decisionId ||
        v.decision.decisionId !==
          'reserve-' +
            createHash('sha256')
              .update(JSON.stringify([q.workspaceId, q.requestId]))
              .digest('hex') ||
        (v.task &&
          (v.task.id !== q.taskId ||
            v.task.ownerRoomId !== q.ownerRoomId ||
            v.task.devBotId !== q.devBotId ||
            v.task.reviewRoomId !== q.reviewRoomId ||
            v.task.reviewBotId !== q.reviewBotId))
      )
        throw Error('invalid_frame');
      return v;
    },
    async listCodingProjects(input) {
      requireFeature();
      const q = validatedParams(input, isCodingProjectsList);
      const v = await send('coding.projects.list', q);
      if (!isCodingProjectsPage(v) || !matchesPage(q, v, v.projects)) throw Error('invalid_frame');
      return v;
    },
    async listCodingTasks(input) {
      requireFeature();
      const q = validatedParams(input, isCodingTasksList);
      const v = await send('coding.tasks.list', q);
      if (!isCodingTasksPage(v) || v.projectId !== q.projectId || !matchesPage(q, v, v.tasks))
        throw Error('invalid_frame');
      return v;
    },
  };
}
