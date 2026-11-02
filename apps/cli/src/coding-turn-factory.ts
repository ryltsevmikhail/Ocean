import { randomUUID } from 'node:crypto';
import type { ChatTurn, CodingTask } from '@runnets/domain';
import {
  CodingTurnTools,
  ToolError,
  type CodingTaskService,
  type CodingTestEvidenceStore,
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

// Raised only by host admission checks before launching any sandbox or provider.
export class CodingTurnRefusal extends ToolError {
  constructor(message: string) {
    super('coding_denied', message);
  }
}

export interface CodingTurnFactoryDeps {
  readonly store: CodingStore;
  readonly evidence: CodingTestEvidenceStore;
  readonly tasks: CodingTaskService;
  readonly approvals: CodingApprovalService;
  readonly journal: ToolJournalPort;
  readonly sandbox: (task: CodingTask) => Promise<SandboxOptions>;
  /** Registered projects reread policy and verify existing targets without setting up a worker. */
  readonly inspectSandbox?: (task: CodingTask) => Promise<SandboxOptions>;
  readonly owner: (turn: ChatTurn, signal: AbortSignal) => CodingApprovalOwnerPort;
}
/** Host composition only. Configuration is supplied by the owner, never model arguments. */
export function codingTurnFactory(deps: CodingTurnFactoryDeps) {
  return {
    async forTurn(turn: ChatTurn, signal: AbortSignal): Promise<CodingTurnTools> {
      signal.throwIfAborted();
      if (!turn.codingTaskId) throw new CodingTurnRefusal('explicit task required');
      const access = {
        taskId: turn.codingTaskId,
        workspaceId: turn.workspaceId,
        roomId: turn.roomId,
        botId: turn.bot.id,
        policyVersion: 1,
        capability: 'project_read' as const,
      };
      const authorized = () => deps.tasks.authorize(access).ok;
      const admission = deps.tasks.authorize(access);
      if (!admission.ok) {
        if (admission.error.code === 'recovery_required')
          throw new ToolError('coding_denied', 'coding recovery required');
        throw new CodingTurnRefusal('task read admission refused');
      }
      const resolved = deps.store.atomic((tx) => ({
        task: tx.task(access.taskId),
        worktree: tx.worktree(access.taskId),
      }));
      if (!resolved.task || resolved.worktree?.state !== 'ready')
        throw new CodingTurnRefusal('ready worktree required');
      const task = resolved.task,
        worktree = resolved.worktree;
      const snapshots = new GitCodingSnapshots();
      const snapshot = async () => (await snapshots.capture(task, worktree)).afterTreeHash;
      const sandbox = await deps.sandbox(task);
      const session = await createCodingOperationSession({
        task,
        sandbox,
        snapshot,
        recordEvidence: (value) => deps.evidence.put(value),
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
        prepare: async (id, call, context) => {
          const operation = await session.prepare(id, call, context.attemptId);
          return {
            ...operation,
            currentBinding: async () => {
              if (!deps.inspectSandbox)
                throw new ToolError('coding_denied', 'read-only sandbox inspection required');
              if (JSON.stringify(await deps.inspectSandbox(task)) !== JSON.stringify(sandbox))
                throw new ToolError('coding_denied', 'registration changed');
              return operation.currentBinding();
            },
          };
        },
      });
    },
  };
}
