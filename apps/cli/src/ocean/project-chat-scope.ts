import type { LocalDecision, LocalRoomScope, LocalRunSnapshot } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node';

export interface ProjectChatScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly devBotId: string;
}

export function devDecision(card: LocalDecision) {
  return card.kind === 'project-read' || card.kind === 'write' || card.kind === 'test';
}

/** Room snapshots are useful for display but do not prove the run belongs to this task. */
export async function hasProjectReceipt(
  client: LocalRuntimeClient,
  room: LocalRoomScope,
  project: ProjectChatScope,
  run: LocalRunSnapshot | null,
) {
  if (!run || run.performerId !== project.devBotId) return false;
  try {
    const receipt = await client.getReceipt({
      ...room,
      requestId: run.requestId,
      taskId: project.taskId,
    });
    return (
      receipt?.runId === run.runId &&
      receipt.turnId === run.turnId &&
      receipt.messageId === run.messageId
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'coding_denied') return false;
    throw error;
  }
}
