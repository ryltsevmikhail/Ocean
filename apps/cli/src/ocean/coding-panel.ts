import { randomUUID } from 'node:crypto';
import { codingTestPassed } from '@runnets/domain';
import type { Runtime } from '../runtime.js';
/** Owner-local immutable evidence view; never appended to room/model history. */
export async function codingPanelLines(
  runtime: Runtime,
  roomId: string,
  taskId: string | undefined,
  mode: 'inspect' | 'capture' = 'capture',
): Promise<readonly string[]> {
  if (taskId === undefined) return ['No coding task selected. Start TUI with --task TASK.'];
  const selected = runtime.coding.inspect('ws_ocean', taskId);
  if (!selected.ok) throw Error(selected.error.code);
  const task = selected.value;
  if (task.ownerRoomId !== roomId) throw Error('coding_denied');
  const access = {
    workspaceId: task.workspaceId,
    taskId,
    roomId,
    botId: task.devBotId,
    policyVersion: task.policyVersion,
    capability: 'project_read' as const,
  };
  const captured =
    mode === 'inspect'
      ? await runtime.codingChanges.preview(access)
      : await runtime.codingChanges.capture(access, 'tui-capture-' + randomUUID());
  if (!captured.ok) throw Error(captured.error.code);
  const artifact = captured.value;
  const tests = runtime.codingEvidence?.list(taskId) ?? [];
  return [
    'Task ' + taskId,
    'Changeset ' + artifact.hash,
    'Base ' + artifact.baseCommit,
    'Tree ' + artifact.afterTreeHash,
    'Frozen view. F6 refreshes; later edits can stale this evidence. This panel grants no application approval.',
    'Registered tests:',
    ...(task.policy.testPresets.length === 0
      ? ['No registered test presets; application is unverified.']
      : task.policy.testPresets.flatMap((preset) => {
          const test = tests.findLast((value) => value.presetId === preset.id);
          if (!test) return [preset.id + ': no recorded result'];
          const current =
            test.afterTreeHash === artifact.afterTreeHash &&
            test.binding.taskId === task.id &&
            test.binding.workspaceId === task.workspaceId &&
            test.binding.projectRoot === task.projectRoot &&
            test.binding.worktreeRoot === task.worktreeRoot &&
            test.binding.roomId === task.ownerRoomId &&
            test.binding.botId === task.devBotId &&
            test.binding.policyVersion === task.policyVersion;
          return [
            `${preset.id}: ${codingTestPassed(test) ? 'passed' : 'failed/unverified'}; ${current ? 'captured tree' : 'STALE binding/tree'}`,
            `evidence ${test.hash}`,
            `exit=${test.exitCode} reason=${test.reason} cleanup=${test.cleanupConfirmed} truncated=${test.truncated} dependenciesUnchanged=${test.dependenciesUnchanged}`,
            'Recorded output:',
            ...test.output.split('\n'),
          ];
        })),
    'Files:',
    ...artifact.files.map(
      (file) => `${file.path}: ${file.before?.mode ?? 'absent'} → ${file.after?.mode ?? 'absent'}`,
    ),
    'Complete diff:',
    ...artifact.diff.split('\n'),
  ];
}
