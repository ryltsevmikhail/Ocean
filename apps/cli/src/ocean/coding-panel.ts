import { randomUUID } from 'node:crypto';
import { MAX_PANEL_LENGTH } from '@runnets/contracts';
import { codingTestPassed, type CodingTask, type CodingTestEvidence } from '@runnets/domain';
import type { Runtime } from '../runtime.js';

function testSummary(task: CodingTask, tree: string, test: CodingTestEvidence): string[] {
  const binding = test.binding;
  const current =
    test.afterTreeHash === tree &&
    binding.taskId === task.id &&
    binding.workspaceId === task.workspaceId &&
    binding.projectRoot === task.projectRoot &&
    binding.worktreeRoot === task.worktreeRoot &&
    binding.roomId === task.ownerRoomId &&
    binding.botId === task.devBotId &&
    binding.policyVersion === task.policyVersion;
  return [
    `${test.presetId}: ${codingTestPassed(test) ? 'passed' : 'failed/unverified'}; ${current ? 'captured tree' : 'STALE binding/tree'}`,
    'evidence ' + test.hash,
    `exit=${test.exitCode} reason=${test.reason} cleanup=${test.cleanupConfirmed} truncated=${test.truncated} dependenciesUnchanged=${test.dependenciesUnchanged}`,
    'Recorded output:',
    test.output,
  ];
}

/** Join the view only after every segment and serialized evidence read fits the budget. */
export async function codingPanelText(
  runtime: Runtime,
  roomId: string,
  taskId: string | undefined,
  mode: 'inspect' | 'capture',
): Promise<string> {
  if (taskId === undefined) return 'No coding task selected. Start TUI with --task TASK.';
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
  const header: string[] = [],
    tests: string[] = [],
    files: string[] = [];
  let remaining = MAX_PANEL_LENGTH + 1; // The first segment has no preceding newline.
  const append = (section: string[], segment: string) => {
    remaining -= Buffer.byteLength(segment) + 1;
    if (remaining < 0) throw Error('changeset_limit');
    section.push(segment);
  };
  for (const line of [
    'Task ' + taskId,
    'Changeset ' + artifact.hash,
    'Base ' + artifact.baseCommit,
    'Tree ' + artifact.afterTreeHash,
    'Frozen view. F6 refreshes; later edits can stale this evidence. This panel grants no application approval.',
    'Registered tests:',
  ])
    append(header, line);
  append(files, 'Files:');
  for (const f of artifact.files)
    append(files, `${f.path}: ${f.before?.mode ?? 'absent'} → ${f.after?.mode ?? 'absent'}`);
  append(files, 'Complete diff:');
  append(files, artifact.diff);
  if (!task.policy.testPresets.length)
    append(tests, 'No registered test presets; application is unverified.');
  let evidenceBudget = remaining;
  for (const preset of task.policy.testPresets) {
    const found = runtime.codingEvidence?.latestForPreset(
      taskId,
      preset.id,
      Math.min(remaining, evidenceBudget),
    );
    if (!found) {
      append(tests, preset.id + ': no recorded result');
      continue;
    }
    evidenceBudget -= found.bytes;
    for (const line of testSummary(task, artifact.afterTreeHash, found.evidence))
      append(tests, line);
  }
  return [...header, ...tests, ...files].join('\n');
}
export async function codingPanelLines(
  runtime: Runtime,
  roomId: string,
  taskId: string | undefined,
) {
  return (await codingPanelText(runtime, roomId, taskId, 'capture')).split('\n');
}
