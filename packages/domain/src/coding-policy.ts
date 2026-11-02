import type { CodingAccess, CodingTask } from './coding-task.js';
export const DEV_CAPABILITIES = ['project_read', 'propose_write', 'run_test_preset'] as const;
export type CodingCapability = (typeof DEV_CAPABILITIES)[number] | 'changeset_read';
export interface CodingTestPreset {
  readonly id: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: '.';
}
export interface CodingPolicy {
  readonly version: 1;
  readonly devCapabilities: readonly CodingCapability[];
  readonly reviewCapabilities: readonly ['changeset_read'];
  readonly testPresets: readonly CodingTestPreset[];
}
/** Missing task, mismatched identity/version or prose-only roles always grant nothing. */
export function codingCapabilities(
  task: CodingTask | null,
  access: Omit<CodingAccess, 'capability'>,
): readonly CodingCapability[] {
  if (
    !task ||
    task.status !== 'reserved' ||
    task.id !== access.taskId ||
    task.workspaceId !== access.workspaceId ||
    task.policyVersion !== access.policyVersion
  )
    return [];
  if (task.devBotId === access.botId && task.ownerRoomId === access.roomId)
    return [...task.policy.devCapabilities];
  if (task.reviewBotId === access.botId && task.reviewRoomId === access.roomId)
    return [...task.policy.reviewCapabilities];
  return [];
}
