import { randomUUID } from 'node:crypto';
import type { ChatTurn, CodingTask } from '@runnets/domain';
import {
  CodingTurnTools,
  ToolError,
  type CodingTaskService,
  type CodingStore,
  type CodingApprovalService,
  type CodingApprovalOwnerPort,
  type ToolJournalPort,
} from '@runnets/application';
import {
  createCodingOperationSession,
  GitCodingSnapshots,
  TOOL_DEFINITIONS,
  type SandboxOptions,
} from '@runnets/tools-node';

export interface CodingTurnFactoryDeps {
  readonly store: CodingStore;
  readonly tasks: CodingTaskService;
  readonly approvals: CodingApprovalService;
  readonly journal: ToolJournalPort;
  readonly sandbox: (task: CodingTask) => Promise<SandboxOptions>;
  readonly owner: (turn: ChatTurn, signal: AbortSignal) => CodingApprovalOwnerPort;
}
/** Host composition only. Configuration is supplied by the owner, never model arguments. */
export function codingTurnFactory(deps: CodingTurnFactoryDeps) {
  return {
    async forTurn(turn: ChatTurn, signal: AbortSignal): Promise<CodingTurnTools> {
      signal.throwIfAborted();
      if (!turn.codingTaskId) throw new ToolError('coding_denied', 'explicit task required');
      const access = {
        taskId: turn.codingTaskId,
        workspaceId: turn.workspaceId,
        roomId: turn.roomId,
        botId: turn.bot.id,
        policyVersion: 1,
        capability: 'project_read' as const,
      };
      const authorized = () => deps.tasks.authorize(access).ok;
      if (!authorized()) throw new ToolError('coding_denied', 'task read admission refused');
      const resolved = deps.store.atomic((tx) => ({
        task: tx.task(access.taskId),
        worktree: tx.worktree(access.taskId),
      }));
      if (!resolved.task || resolved.worktree?.state !== 'ready')
        throw new ToolError('coding_denied', 'ready worktree required');
      const task = resolved.task,
        worktree = resolved.worktree;
      const snapshots = new GitCodingSnapshots();
      const snapshot = async () => (await snapshots.capture(task, worktree)).afterTreeHash;
      const session = await createCodingOperationSession({
        task,
        sandbox: await deps.sandbox(task),
        snapshot,
        scope: {
          roomId: turn.roomId,
          botId: turn.bot.id,
          runId: turn.taskRunId,
          attemptId: 'unassigned',
          invocationId: 'unassigned',
        },
      });
      if (!authorized())
        throw new ToolError('coding_denied', 'task authority changed during qualification');
      return new CodingTurnTools({
        definitions: TOOL_DEFINITIONS,
        presets: task.policy.testPresets,
        approvals: deps.approvals,
        owner: deps.owner(turn, signal),
        journal: deps.journal,
        taskRunId: turn.taskRunId,
        nextId: () => randomUUID(),
        admit: () => authorized(),
        read: (call, signal) => session.read(call, signal),
        prepare: (id, call, context) => session.prepare(id, call, context.attemptId),
      });
    },
  };
}
