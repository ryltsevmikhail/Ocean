import { MAX_PANEL_LENGTH } from '@runnets/contracts';
import { codingTestPassed } from '@runnets/domain';
import type { CodingReadMethod, LocalCodingRead } from '@runnets/contracts';
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
