import { taskRunId, type ChatTurn } from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import type { TaskRunService } from './service.js';
import type { ToolEffectRecord, ToolJournalPort } from './tools.js';

export interface ReviewSnapshot {
  readonly taskRunId: string;
  readonly roomId: string | null;
  readonly turnStatus: string | null;
  readonly taskStatus: string;
  readonly taskVersion: number;
  readonly version: string;
  readonly globalPendingEffects: number;
  readonly relatedPendingEffects: number;
  readonly effects: readonly Pick<
    ToolEffectRecord,
    'id' | 'tool' | 'taskRunId' | 'attemptId' | 'outcome'
  >[];
  readonly canAcknowledge: boolean;
  readonly mode: 'text_only' | null;
}
/** Read evidence synchronously inside the same critical section that commits the decision. */
export function reviewVersion(
  tx: ConversationTransaction,
  tasks: TaskRunService,
  journal: ToolJournalPort,
  id: string,
  turn: ChatTurn | null,
): string | null {
  const version = tasks.committedVersion(taskRunId(id));
  if (version === null || journal.inspectPending === undefined) return null;
  const effects = journal
    .inspectPending()
    .map((e) => [e.taskRunId, e.attemptId, e.id, e.outcome, e.tool]);
  effects.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return JSON.stringify([
    id,
    version,
    turn?.status ?? null,
    turn?.continuationReviewId ?? null,
    turn === null ? null : tx.roomPolicy(turn.roomId),
    effects,
  ]);
}
