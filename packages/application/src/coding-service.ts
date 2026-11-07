import {
  ok,
  codingFailure,
  codingCapabilities,
  type CodingAccess,
  type CodingResult,
  type CodingTask,
  type CodingPolicy,
  type ProjectLease,
  type CodingErrorCode,
  type ToolEffectAdmission,
} from '@runnets/domain';
import {
  codingResourceAdmission,
  codingResourceWorktree,
  qualifiedCodingResourceFootprint,
} from './coding-resource-scope.js';
import type { Clock } from './ports.js';
import type { ToolJournalPort } from './tools.js';
import type {
  CodingStore,
  ProjectLeasePort,
  CodingProjectPort,
  StartCodingTask,
  CodingOwnerPort,
  CodingTransaction,
} from './coding-ports.js';
import { validCodingStart, codingParticipants, codingBinding } from './coding-validation.js';
import { reservationReceipt } from './coding-receipt.js';
export interface CodingServiceDeps {
  readonly store: CodingStore;
  readonly leases: ProjectLeasePort;
  readonly projects: CodingProjectPort;
  readonly journal: ToolJournalPort;
  readonly ownerId: string;
  readonly clock: Clock;
  readonly restored?: boolean;
  readonly enabled?: boolean;
  /** Trusted canonical-root identity, shared with durable coding admission. */
  readonly projectId?: (canonicalRoot: string) => string;
}
/** Reservation and admission only. No worktree or executable capability is created in stage 1. */
export class CodingTaskService {
  readonly #deps: CodingServiceDeps;
  constructor(deps: CodingServiceDeps) {
    this.#deps = deps;
  }
  #resource(root: string, worktree?: { id: string; root: string }) {
    try {
      const id = this.#deps.projectId?.(root);
      return id ? codingResourceAdmission(root, id, worktree) : undefined;
    } catch {
      return undefined;
    }
  }
  #pending(admission?: ToolEffectAdmission): boolean {
    const journal = this.#deps.journal;
    return (
      !journal.inspectPending ||
      (journal.inspectConflicts?.(admission) ?? journal.inspectPending()).length > 0
    );
  }
  #scope(tx: CodingTransaction, task: CodingTask) {
    const worktree = tx.worktree(task.id);
    if (
      !codingResourceWorktree(task, worktree) ||
      !this.#deps.leases.owns(task.lease) ||
      (worktree && !this.#deps.leases.owns(worktree.lease))
    )
      return undefined;
    return this.#resource(
      task.projectRoot,
      worktree ? { id: task.id, root: worktree.root } : undefined,
    );
  }
  // No requested-path scope before inspection. Only qualified evidence permits this read.
  #inspectionHeld(): boolean {
    const journal = this.#deps.journal;
    return !this.#deps.projectId || !journal.inspectConflicts
      ? this.#pending()
      : !journal.inspectPending ||
          journal.inspectPending().some((r) => !qualifiedCodingResourceFootprint(r.admission));
  }
  async start(request: StartCodingTask, owner: CodingOwnerPort): Promise<CodingResult<CodingTask>> {
    if (this.#deps.enabled === false) return codingFailure('coding_unavailable');
    const i = structuredClone(request);
    if (!validCodingStart(i)) return codingFailure('invalid_input');
    if (this.#deps.restored) return codingFailure('recovery_required');
    const binding = codingBinding(i);
    const previous = this.reservationReceipt(i);
    if (!previous.ok || previous.value) return previous as CodingResult<CodingTask>;
    if (this.#inspectionHeld()) return codingFailure('recovery_required');
    // A finalizing/uncertain finalization still owns the project reservation.
    if (this.#deps.store.projectHeld(i.projectRoot)) return codingFailure('recovery_required');
    if (this.#deps.store.atomic((tx) => tx.task(i.taskId)))
      return codingFailure('request_conflict');
    let project: Awaited<ReturnType<CodingProjectPort['inspect']>>;
    try {
      project = await this.#deps.projects.inspect(i.projectRoot);
    } catch {
      return codingFailure('invalid_input');
    }
    if (this.#pending(this.#resource(project.root))) return codingFailure('recovery_required');
    if (!project.clean) return codingFailure('project_changed');
    if (this.#deps.store.projectHeld(project.root)) return codingFailure('recovery_required');
    if (!this.#deps.store.atomic((tx) => codingParticipants(tx, i, project.root)))
      return codingFailure('coding_denied');
    const policy: CodingPolicy = {
      version: 1,
      devCapabilities: [...i.devCapabilities],
      reviewCapabilities: ['changeset_read'],
      testPresets: structuredClone(i.testPresets),
    };
    if (
      !(await owner.confirm(
        structuredClone({
          operation: 'reserve',
          workspaceId: i.workspaceId,
          ownerRoomId: i.ownerRoomId,
          devBotId: i.devBotId,
          reviewRoomId: i.reviewRoomId,
          reviewBotId: i.reviewBotId,
          baseCommit: project.baseCommit,
          taskId: i.taskId,
          projectRoot: project.root,
          policy,
        }),
      ))
    )
      return codingFailure('approval_required');
    if (this.#pending(this.#resource(project.root)) || this.#deps.store.projectHeld(project.root))
      return codingFailure('recovery_required');
    const lease = this.#deps.leases.acquire(project.root, {
      ownerId: this.#deps.ownerId,
      taskId: i.taskId,
      requestId: i.requestId,
      binding,
      kind: 'coding',
    });
    if (!lease.ok) return lease;
    // A crash or storage exception keeps the durable reservation; it never guesses that release is safe.
    let latest: typeof project;
    try {
      latest = await this.#deps.projects.inspect(i.projectRoot);
    } catch {
      return this.#deps.store.atomic((tx) =>
        this.#rejectUnused(tx, lease.value, 'project_changed'),
      );
    }
    if (!latest.clean || latest.root !== project.root || latest.baseCommit !== project.baseCommit)
      return this.#deps.store.atomic((tx) =>
        this.#rejectUnused(tx, lease.value, 'project_changed'),
      );
    return this.#deps.store.atomic((tx) => {
      const receipt = tx.receipt(i.requestId);
      if (receipt)
        return receipt.binding === binding && tx.task(receipt.taskId)
          ? ok(tx.task(receipt.taskId)!)
          : codingFailure('request_conflict');
      if (tx.task(i.taskId)) return this.#rejectUnused(tx, lease.value, 'request_conflict');
      if (
        this.#pending(this.#resource(project.root)) ||
        this.#deps.store.projectHeld(i.projectRoot) ||
        this.#deps.store.projectHeld(project.root)
      )
        return this.#rejectUnused(tx, lease.value, 'recovery_required');
      if (!codingParticipants(tx, i, project.root))
        return this.#rejectUnused(tx, lease.value, 'coding_denied');
      if (!this.#deps.leases.owns(lease.value)) return codingFailure('project_busy');
      const task: CodingTask = {
        id: i.taskId,
        workspaceId: i.workspaceId,
        projectRoot: project.root,
        baseCommit: project.baseCommit,
        worktreeRoot: null,
        ownerRoomId: i.ownerRoomId,
        devBotId: i.devBotId,
        reviewBotId: i.reviewBotId,
        reviewRoomId: i.reviewRoomId,
        status: 'reserved',
        policyVersion: 1,
        policy,
        lease: lease.value,
        createdAt: this.#deps.clock.now().toISOString(),
      };
      tx.putTask(task);
      tx.putReceipt(i.requestId, { binding, taskId: task.id });
      return ok(task);
    });
  }
  #rejectUnused(
    tx: CodingTransaction,
    lease: ProjectLease,
    code: CodingErrorCode,
  ): CodingResult<never> {
    if (tx.task(lease.taskId)?.lease.token !== lease.token && !this.#deps.leases.release(lease))
      return codingFailure('recovery_required');
    return codingFailure(code);
  }
  reservationReceipt(input: StartCodingTask): CodingResult<CodingTask | null> {
    return reservationReceipt(this.#deps, input);
  }
  inspect(workspaceId: string, taskId: string): CodingResult<CodingTask> {
    return this.#deps.store.atomic((tx) => {
      const task = tx.task(taskId);
      return task && task.workspaceId === workspaceId && task.lease.ownerId === this.#deps.ownerId
        ? ok(task)
        : codingFailure('coding_denied');
    });
  }
  authorize(
    access: CodingAccess,
  ): CodingResult<{ readonly taskId: string; readonly executionEnabled: false }> {
    if (this.#deps.enabled === false) return codingFailure('coding_unavailable');
    if (this.#deps.restored) return codingFailure('recovery_required');
    return this.#deps.store.atomic((tx) => {
      const task = tx.task(access.taskId);
      if (
        !task ||
        task.lease.ownerId !== this.#deps.ownerId ||
        !codingCapabilities(task, access).includes(access.capability) ||
        !tx.participates(access.workspaceId, access.roomId, access.botId)
      )
        return codingFailure('coding_denied');
      if (this.#pending(this.#scope(tx, task))) return codingFailure('recovery_required');
      const worktree = tx.worktree(task.id);
      if (
        !this.#deps.leases.owns(task.lease) ||
        (worktree && !this.#deps.leases.owns(worktree.lease))
      )
        return codingFailure('project_busy');
      return ok({ taskId: task.id, executionEnabled: false as const });
    });
  }
  async cancel(
    workspaceId: string,
    taskId: string,
    owner: CodingOwnerPort,
  ): Promise<CodingResult<CodingTask>> {
    if (this.#deps.enabled === false) return codingFailure('coding_unavailable');
    if (this.#deps.restored) return codingFailure('recovery_required');
    const task = this.#deps.store.atomic((tx) => tx.task(taskId));
    if (!task || task.workspaceId !== workspaceId || task.lease.ownerId !== this.#deps.ownerId)
      return codingFailure('coding_denied');
    if (
      task.worktreeRoot !== null ||
      this.#deps.store.atomic((tx) => this.#pending(this.#scope(tx, task)))
    )
      return codingFailure('recovery_required');
    if (!this.#deps.leases.owns(task.lease) && task.status !== 'cancelled')
      return codingFailure('project_busy');
    // Finalization is not cancellation: never claim a disabled task was cancelled.
    if (task.status !== 'reserved' && task.status !== 'cancelled')
      return codingFailure('recovery_required');
    if (
      task.status === 'reserved' &&
      !(await owner.confirm(
        structuredClone({
          operation: 'cancel',
          workspaceId: task.workspaceId,
          ownerRoomId: task.ownerRoomId,
          devBotId: task.devBotId,
          reviewRoomId: task.reviewRoomId,
          reviewBotId: task.reviewBotId,
          baseCommit: task.baseCommit,
          taskId,
          projectRoot: task.projectRoot,
          policy: task.policy,
        }),
      ))
    )
      return codingFailure('approval_required');
    const result = this.#deps.store.atomic((tx) => {
      const current = tx.task(taskId);
      if (
        !current ||
        current.worktreeRoot !== null ||
        (current.status !== 'reserved' && current.status !== 'cancelled') ||
        this.#pending(this.#scope(tx, current))
      )
        return codingFailure('recovery_required');
      if (current.status === 'reserved' && !this.#deps.leases.owns(current.lease))
        return codingFailure('project_busy');
      const cancelled = { ...current, status: 'cancelled' as const };
      tx.putTask(cancelled);
      return ok(cancelled);
    });
    if (result.ok && !this.#deps.leases.release(task.lease))
      return codingFailure('recovery_required');
    return result;
  }
}
