import type { ServiceJson } from '@runnets/domain';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson as importCanonical, type ChatTurn, type CodingTask } from '@runnets/domain';
import {
  CodingTurnTools,
  ToolError,
  ChatPreparationRefusal,
  type CodingTaskService,
  type ProjectLeasePort,
  type PreparedCodingOperation,
  type ToolDispatchGuard,
  selectedCodingBasis,
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
export class CodingTurnRefusal extends ChatPreparationRefusal {}

export interface CodingTurnFactoryDeps {
  readonly store: CodingStore;
  readonly evidence: CodingTestEvidenceStore;
  readonly tasks: CodingTaskService;
  readonly approvals: CodingApprovalService;
  readonly journal: ToolJournalPort;
  readonly leases?: ProjectLeasePort;
  readonly sandbox: (task: CodingTask) => Promise<SandboxOptions>;
  /** Registered projects reread policy and verify existing targets without setting up a worker. */
  readonly inspectSandbox?: (task: CodingTask) => Promise<SandboxOptions>;
  readonly owner: (turn: ChatTurn, signal: AbortSignal) => CodingApprovalOwnerPort;
}
/** Host composition only. Configuration is supplied by the owner, never model arguments. */
export function codingTurnFactory(deps: CodingTurnFactoryDeps) {
  return {
    async forTurn(turn: ChatTurn, signal: AbortSignal) {
      if (signal.aborted) throw new CodingTurnRefusal('cancelled before coding preparation');
      if (!turn.codingTaskId) throw new CodingTurnRefusal('explicit task required');
      const marked = turn.roomDelivery !== undefined;
      const access = {
        taskId: turn.codingTaskId,
        workspaceId: turn.workspaceId,
        roomId: turn.roomId,
        botId: turn.bot.id,
        policyVersion: 1,
        capability: 'project_read' as const,
      };
      const authorized = (
        capability: 'project_read' | 'propose_write' | 'run_test_preset' = 'project_read',
      ) => deps.tasks.authorize({ ...access, capability }).ok;
      const admission =
        (marked
          ? (['project_read', 'propose_write', 'run_test_preset'] as const)
              .map((capability) => deps.tasks.authorize({ ...access, capability }))
              .find((r) => r.ok)
          : undefined) ?? deps.tasks.authorize(access);
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
      const snapshot = async (guard?: ToolDispatchGuard) => {
        if (marked && guard?.inspect?.() !== true)
          throw new ToolError('coding_denied', 'snapshot scope refused');
        return (await snapshots.capture(task, worktree, guard)).afterTreeHash;
      };
      const leasesCurrent = () =>
        deps.store.atomic((tx) => {
          const current = tx.task(task.id),
            wt = tx.worktree(task.id);
          return (
            !!deps.leases &&
            !!current &&
            !!wt &&
            current.status === 'reserved' &&
            current.devBotId === turn.bot.id &&
            current.ownerRoomId === turn.roomId &&
            current.worktreeRoot === wt.root &&
            wt.state === 'ready' &&
            JSON.stringify(current.lease) === JSON.stringify(task.lease) &&
            JSON.stringify(wt.lease) === JSON.stringify(worktree.lease) &&
            deps.leases.owns(current.lease) &&
            deps.leases.owns(wt.lease)
          );
        });
      const actions = (selection = false, claimed = false) =>
        deps.approvals.deps.store.atomic((tx) => {
          const scope = tx.roomScope?.(
            turn.taskRunId,
            deps.approvals.deps.now(),
            selection ? true : undefined,
          );
          if (!scope || scope.reviewer || !tx.projectId) return [];
          const resource = {
            kind: 'project-worktree' as const,
            projectId: tx.projectId(task.projectRoot),
            worktreeId: task.id,
          };
          return (['project_read', 'propose_write', 'run_test_preset'] as const).filter(
            (action) =>
              task.policy.devCapabilities.includes(action) &&
              !!selectedCodingBasis(tx, scope, action, resource, 0, claimed),
          );
        });
      const selected = marked ? actions(true) : undefined;
      if (marked && !leasesCurrent()) throw new CodingTurnRefusal('room coding selection refused');
      let sandbox: SandboxOptions;
      let sessionPromise: ReturnType<typeof createCodingOperationSession> | undefined;
      const getSession = (guard?: ToolDispatchGuard) => {
        sessionPromise ??= (async () => {
          if (marked ? !guard?.authorize() : !authorized())
            throw new CodingTurnRefusal('coding scope refused');
          sandbox = await deps.sandbox(task);
          if (marked ? !guard?.authorize() : !authorized())
            throw new CodingTurnRefusal('coding authority changed during qualification');
          return createCodingOperationSession({
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
            ...(guard ? { guard, signal } : {}),
          });
        })();
        return sessionPromise;
      };
      if (!marked) await getSession();
      const owner = deps.owner(turn, signal);
      return Object.assign(
        new CodingTurnTools({
          definitions: TOOL_DEFINITIONS,
          presets: task.policy.testPresets,
          ...(selected ? { actions: selected } : {}),
          approvals: deps.approvals,
          owner,
          journal: deps.journal,
          taskRunId: turn.taskRunId,
          nextId: () => randomUUID(),
          admit: () => (marked ? leasesCurrent() && actions().length > 0 : authorized()),
          read: async (call, callSignal, context) => {
            if (!marked) return (await getSession()).read(call, callSignal);
            if (!context) throw new ToolError('coding_denied', 'read actor missing');
            const request = {
              workspaceId: turn.workspaceId,
              roomId: turn.roomId,
              botId: turn.bot.id,
              taskId: task.id,
              projectRoot: task.projectRoot,
              worktreeRoot: worktree.root,
              runId: context.taskRunId,
              attemptId: context.attemptId,
              invocationId: call.id,
              tool: call.name as 'read_file' | 'list_files',
              arguments: JSON.parse(call.arguments) as ServiceJson,
              operationDigest: createHash('sha256')
                .update(importCanonical([call.name, JSON.parse(call.arguments)]))
                .digest('hex'),
            };
            const claim = await deps.approvals.claimRead(request, owner, callSignal, () =>
              Promise.resolve(authorized() && leasesCurrent()),
            );
            if (!claim) throw new ToolError('coding_denied', 'read claim refused');
            let entered = false;
            const guard: ToolDispatchGuard = {
              authorize: () => leasesCurrent() && claim.authorize(),
              inspect: () => leasesCurrent() && claim.authorize(),
            };
            try {
              if (!guard.authorize()) {
                claim.settle('not_started');
                throw new ToolError('coding_denied', 'read dispatch refused');
              }
              entered = true;
              const session = await getSession(guard);
              const result = await session.read(call, callSignal, guard);
              claim.settle(
                result.uncertain ? 'uncertain' : result.isError ? 'failed' : 'completed',
              );
              return result;
            } catch (error) {
              if (entered) claim.settle('uncertain');
              throw error;
            }
          },
          prepare: async (id, call, context) => {
            const action = call.name === 'run_command' ? 'run_test_preset' : 'propose_write';
            let prepared: PreparedCodingOperation | undefined = undefined;
            const inspect = () => {
              if (signal.aborted || !leasesCurrent()) return false;
              const approval = deps.approvals.deps.store.atomic((tx) => tx.approval(id));
              if (approval?.status === 'consumed')
                return !!prepared && deps.approvals.authorizeDispatch(id, prepared.binding);
              return authorized(action) && actions().includes(action);
            };
            const preparationGuard: ToolDispatchGuard = { authorize: inspect, inspect };
            if (marked && !preparationGuard.authorize())
              throw new ToolError('coding_denied', 'mutation preparation refused');
            const session = await getSession(marked ? preparationGuard : undefined);
            const operation = await session.prepare(
              id,
              call,
              context.attemptId,
              marked ? preparationGuard : undefined,
              signal,
            );
            prepared = operation;
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
        }),
        {
          cleanupConfirmed: true as const,
          callDigest: (text: string) => createHash('sha256').update(text).digest('hex'),
        },
      );
    },
  };
}
