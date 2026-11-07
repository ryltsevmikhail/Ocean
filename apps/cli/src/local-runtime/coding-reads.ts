import { MAX_PANEL_LENGTH } from '@runnets/contracts';
import {
  codingCapabilities,
  codingTestPassed,
  type Changeset,
  type CodingAccess,
} from '@runnets/domain';
import type {
  CodingChangesetSummary,
  CodingReadMethod,
  LocalCodingPanel,
  LocalCodingRead,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import type { ProfileReads } from '@runnets/store-sqlite';

/** Resolve scope before inspecting files. Never return a project lease token or execute a capture. */
export async function codingRead(
  runtime: Runtime,
  reads: ProfileReads,
  method: CodingReadMethod,
  q: LocalCodingRead,
) {
  const taskId =
    method === 'coding.inspect-apply'
      ? reads.applicationTask(q.workspaceId, q.id, q.roomId ?? null)
      : q.id;
  if (!taskId) throw Error('coding_denied');
  const selected = runtime.coding.inspect(q.workspaceId, taskId);
  if (!selected.ok) throw Error(selected.error.code);
  const task = selected.value,
    roomId = task.ownerRoomId;
  if (q.roomId !== undefined && q.roomId !== roomId) throw Error('coding_denied');
  const members = runtime.conversations.members(q.workspaceId, roomId);
  if (!members.ok || !members.value.some((b) => b.id === task.devBotId))
    throw Error('coding_denied');
  if (method === 'coding.show') {
    const { lease, ...metadata } = task;
    void lease;
    return metadata;
  }
  if (method === 'coding.diff') {
    if (task.status === 'finalizing' || task.status === 'finalized') {
      const frozen = runtime.codingChanges.history({
        workspaceId: q.workspaceId,
        taskId,
        roomId,
        botId: task.devBotId,
        policyVersion: task.policyVersion,
        capability: 'project_read',
      });
      if (!frozen.ok) throw Error(frozen.error.code);
      const tests = (runtime.codingEvidence?.list(taskId) ?? []).map((e) => ({
        presetId: e.presetId ?? null,
        hash: e.hash,
        passed: codingTestPassed(e),
        afterTreeHash: e.afterTreeHash,
      }));
      return { ...frozen.value, kind: 'frozen', tests, workspaceId: q.workspaceId, roomId };
    }
    const result = await runtime.codingChanges.preview({
      workspaceId: q.workspaceId,
      taskId,
      roomId,
      botId: task.devBotId,
      policyVersion: task.policyVersion,
      capability: 'project_read',
    });
    if (!result.ok) throw Error(result.error.code);
    let remaining = MAX_PANEL_LENGTH;
    const tests = task.policy.testPresets.map(({ id: presetId }) => {
      const found = runtime.codingEvidence?.latestForPreset(taskId, presetId, remaining);
      if (!found) return { presetId, evidence: null };
      const e = found.evidence,
        b = e.binding;
      remaining -= found.bytes;
      if (
        b.workspaceId !== q.workspaceId ||
        b.taskId !== task.id ||
        b.roomId !== roomId ||
        b.botId !== task.devBotId
      )
        throw Error('coding_denied');
      return {
        presetId,
        evidence: {
          hash: e.hash,
          binding: b,
          passed: codingTestPassed(e),
          current:
            e.afterTreeHash === result.value.afterTreeHash &&
            b.projectRoot === task.projectRoot &&
            b.worktreeRoot === task.worktreeRoot &&
            b.policyVersion === task.policyVersion,
          afterTreeHash: e.afterTreeHash,
        },
      };
    });
    return { ...result.value, kind: 'preview', tests, workspaceId: q.workspaceId, roomId };
  }
  const result = await runtime.codingApplyInspection?.inspect({
    workspaceId: q.workspaceId,
    applicationId: q.id,
  });
  if (!result?.ok) throw Error(result?.error.code ?? 'coding_unavailable');
  if (result.value.receipt.taskId !== taskId) throw Error('coding_denied');
  return { ...result.value, workspaceId: q.workspaceId, roomId };
}

type CodingOwnerRuntime = Pick<Runtime, 'coding' | 'conversationStore' | 'conversations'>;

/** Resolve current owner/dev scope, independently of eligibility to start new work. */
export function codingOwnerTask(runtime: CodingOwnerRuntime, q: LocalCodingPanel) {
  const selected = runtime.coding.inspect(q.workspaceId, q.taskId);
  if (!selected.ok) throw Error(selected.error.code);
  const task = selected.value;
  const workspace = runtime.conversationStore?.atomic((tx) => tx.workspace());
  if (
    workspace?.id !== q.workspaceId ||
    workspace.root !== task.projectRoot ||
    task.ownerRoomId !== q.roomId
  )
    throw Error('coding_denied');
  const members = runtime.conversations.members(q.workspaceId, q.roomId);
  if (!members.ok || !members.value.some((b) => b.id === task.devBotId))
    throw Error('coding_denied');
  return task;
}

export function codingSnapshotAccess(
  runtime: CodingOwnerRuntime,
  q: LocalCodingPanel & { expectedPolicyVersion?: number },
): CodingAccess {
  const task = codingOwnerTask(runtime, q);
  const access = {
    taskId: task.id,
    workspaceId: q.workspaceId,
    roomId: q.roomId,
    botId: task.devBotId,
    policyVersion: task.policyVersion,
    capability: 'project_read' as const,
  };
  if (
    (q.expectedPolicyVersion !== undefined && q.expectedPolicyVersion !== task.policyVersion) ||
    (!codingCapabilities(task, access).includes(access.capability) &&
      task.status !== 'finalizing' &&
      task.status !== 'finalized')
  )
    throw Error('coding_denied');
  return access;
}

export function codingSnapshotSummary(
  scope: LocalCodingPanel,
  snapshot: Changeset,
): CodingChangesetSummary {
  return {
    workspaceId: scope.workspaceId,
    roomId: scope.roomId,
    taskId: snapshot.taskId,
    hash: snapshot.hash,
    baseCommit: snapshot.baseCommit,
    beforeTreeHash: snapshot.beforeTreeHash,
    afterTreeHash: snapshot.afterTreeHash,
    fileCount: snapshot.files.length,
  };
}
