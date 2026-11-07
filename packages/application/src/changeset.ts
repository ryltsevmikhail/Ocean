import {
  validConversationText,
  codingCapabilities,
  codingFailure,
  CodingArtifactError,
  ok,
  type CodingAccess,
  type CodingTask,
  type CodingResult,
  type CodingWorktree,
  type Changeset,
} from '@runnets/domain';
import type { CodingServiceDeps } from './coding-service.js';
import type { CodingTransaction } from './coding-ports.js';
import type { WorktreePort, ChangesetPort, CodingWorktreeOwnerPort } from './changeset-ports.js';
export interface ChangesetServiceDeps extends CodingServiceDeps {
  readonly worktrees: WorktreePort;
  readonly snapshots: ChangesetPort;
}
/** Only host-authorized task preparation and immutable artifact I/O; still no executable chat tools. */
export class CodingChangesetService {
  readonly #deps: ChangesetServiceDeps;
  constructor(deps: ChangesetServiceDeps) {
    this.#deps = deps;
  }
  #task(tx: CodingTransaction, access: CodingAccess, frozen = false): CodingTask | null {
    const task = tx.task(access.taskId);
    if (
      this.#deps.enabled === false ||
      this.#deps.restored ||
      !task ||
      task.lease.ownerId !== this.#deps.ownerId ||
      !tx.participates(access.workspaceId, access.roomId, access.botId)
    )
      return null;
    if (frozen) {
      // Disabled tasks keep immutable diff/review reads for their exact participants,
      // but every capability is empty so no execution authority is revived.
      const disabled = task.status === 'finalizing' || task.status === 'finalized',
        participant =
          access.capability === 'changeset_read'
            ? task.reviewBotId === access.botId && task.reviewRoomId === access.roomId
            : task.devBotId === access.botId && task.ownerRoomId === access.roomId;
      return codingCapabilities(task, access).includes(access.capability) ||
        (disabled && participant)
        ? task
        : null;
    }
    if (!codingCapabilities(task, access).includes(access.capability)) return null;
    if (
      access.capability !== 'project_read' ||
      access.botId !== task.devBotId ||
      !this.#deps.leases.owns(task.lease) ||
      this.#deps.journal.inspectPending === undefined ||
      this.#deps.journal.inspectPending().length
    )
      return null;
    return task;
  }
  /** Read and verify durable readiness; never plans, confirms or creates a worktree. */
  async prepared(input: CodingAccess): Promise<CodingResult<CodingWorktree | null>> {
    const access = structuredClone(input);
    const selected = this.#deps.store.atomic((tx) => ({
      task: this.#task(tx, access),
      worktree: tx.worktree(access.taskId),
    }));
    const { task, worktree } = selected;
    if (!task) return codingFailure('coding_denied');
    if (!worktree)
      return task.worktreeRoot === null ? ok(null) : codingFailure('recovery_required');
    if (
      worktree.state !== 'ready' ||
      worktree.taskId !== task.id ||
      worktree.workspaceId !== task.workspaceId ||
      worktree.projectRoot !== task.projectRoot ||
      worktree.baseCommit !== task.baseCommit ||
      worktree.root !== task.worktreeRoot ||
      worktree.lease.ownerId !== this.#deps.ownerId ||
      worktree.lease.taskId !== task.id ||
      worktree.lease.projectRoot !== worktree.root ||
      !this.#deps.leases.owns(worktree.lease)
    )
      return codingFailure('recovery_required');
    try {
      await this.#deps.worktrees.verify(task, worktree);
    } catch {
      return codingFailure('recovery_required');
    }
    return this.#deps.store.atomic((tx) => {
      const current = this.#task(tx, access);
      return current &&
        JSON.stringify(current) === JSON.stringify(task) &&
        JSON.stringify(tx.worktree(task.id)) === JSON.stringify(worktree) &&
        this.#deps.leases.owns(worktree.lease)
        ? ok(worktree)
        : codingFailure('recovery_required');
    });
  }
  async prepare(
    input: CodingAccess,
    owner: CodingWorktreeOwnerPort,
  ): Promise<CodingResult<CodingWorktree>> {
    const access = structuredClone(input),
      task = this.#deps.store.atomic((tx) => this.#task(tx, access));
    if (!task) return codingFailure('coding_denied');
    const existing = await this.prepared(access);
    if (!existing.ok || existing.value) return existing as CodingResult<CodingWorktree>;
    let plan: Awaited<ReturnType<WorktreePort['plan']>>;
    try {
      plan = await this.#deps.worktrees.plan(task);
      await this.#deps.worktrees.preflight(task);
    } catch (error) {
      return codingFailure(
        error instanceof CodingArtifactError ? error.code : 'worktree_unavailable',
      );
    }
    if (!(await owner.confirm(structuredClone({ task, plan }))))
      return codingFailure('approval_required');
    let project: Awaited<ReturnType<ChangesetServiceDeps['projects']['inspect']>>;
    try {
      project = await this.#deps.projects.inspect(task.projectRoot);
    } catch {
      return codingFailure('project_changed');
    }
    if (
      !project.clean ||
      project.root !== task.projectRoot ||
      project.baseCommit !== task.baseCommit
    )
      return codingFailure('project_changed');
    const prepared = this.#deps.store.atomic((tx) => {
      const current = this.#task(tx, access);
      if (!current || current.worktreeRoot !== null || tx.worktree(task.id))
        return codingFailure('recovery_required');
      const lease = this.#deps.leases.acquire(plan.root, {
        ownerId: this.#deps.ownerId,
        taskId: task.id,
        requestId: 'worktree-' + task.id,
        binding: JSON.stringify([task.id, task.baseCommit, plan]),
        kind: 'coding',
      });
      if (!lease.ok) return lease;
      const record: CodingWorktree = {
        ...plan,
        taskId: task.id,
        projectRoot: task.projectRoot,
        baseCommit: task.baseCommit,
        workspaceId: task.workspaceId,
        state: 'preparing',
        lease: lease.value,
      };
      tx.putWorktree(record);
      tx.putTask({ ...current, worktreeRoot: plan.root });
      return ok(record);
    });
    if (!prepared.ok) return prepared;
    const record = prepared.value;
    try {
      await this.#deps.worktrees.create(task, plan);
      await this.#deps.worktrees.verify(task, record);
      return this.#deps.store.atomic((tx) => {
        const current = this.#task(tx, access),
          intent = tx.worktree(task.id);
        if (!current || intent?.state !== 'preparing' || !this.#deps.leases.owns(record.lease))
          return codingFailure('recovery_required');
        const ready = { ...record, state: 'ready' as const };
        tx.putWorktree(ready);
        return ok(ready);
      });
    } catch (error) {
      this.#deps.store.atomic((tx) => {
        const current = tx.worktree(task.id);
        if (current?.state === 'preparing') tx.putWorktree({ ...current, state: 'uncertain' });
      });
      return codingFailure(error instanceof CodingArtifactError ? error.code : 'recovery_required');
    }
  }
  capture(input: CodingAccess, requestId: string): Promise<CodingResult<Changeset>> {
    if (!validConversationText(requestId, 128))
      return Promise.resolve(codingFailure('invalid_input'));
    return this.#snapshot(input, requestId);
  }
  /** Inspect the same verified tree without publishing an artifact or a capture receipt. */
  preview(input: CodingAccess): Promise<CodingResult<Changeset>> {
    return this.#snapshot(input);
  }
  async #snapshot(input: CodingAccess, requestId?: string): Promise<CodingResult<Changeset>> {
    const access = structuredClone(input);
    const binding = JSON.stringify([
      access.taskId,
      access.workspaceId,
      access.roomId,
      access.botId,
      access.policyVersion,
      access.capability,
    ]);
    const receipt = this.#deps.store.atomic((tx) => {
      const task = this.#task(tx, access, true);
      return requestId !== undefined &&
        task &&
        access.botId === task.devBotId &&
        access.capability === 'project_read'
        ? tx.captureReceipt(requestId)
        : null;
    });
    if (receipt)
      return receipt.binding === binding
        ? this.read(access, receipt.hash)
        : codingFailure('request_conflict');
    const selected = this.#deps.store.atomic((tx) => {
      const task = this.#task(tx, access);
      if (!task) return null;
      const worktree = tx.worktree(task.id);
      return worktree?.state === 'ready' && this.#deps.leases.owns(worktree.lease)
        ? { task, worktree, receipt: requestId === undefined ? null : tx.captureReceipt(requestId) }
        : null;
    });
    if (!selected) return codingFailure('coding_denied');
    if (selected.receipt)
      return selected.receipt.binding === binding
        ? this.read(access, selected.receipt.hash)
        : codingFailure('request_conflict');
    let snapshot: Changeset;
    try {
      snapshot = await this.#deps.snapshots.capture(selected.task, selected.worktree);
    } catch (error) {
      return codingFailure(error instanceof CodingArtifactError ? error.code : 'recovery_required');
    }
    if (
      snapshot.taskId !== selected.task.id ||
      snapshot.baseCommit !== selected.task.baseCommit ||
      snapshot.id !== snapshot.hash ||
      !/^[a-f0-9]{64}$/.test(snapshot.hash)
    )
      return codingFailure('recovery_required');
    return this.#deps.store.atomic((tx) => {
      const task = this.#task(tx, access),
        worktree = tx.worktree(access.taskId);
      if (!task || worktree?.state !== 'ready' || !this.#deps.leases.owns(worktree.lease))
        return codingFailure('recovery_required');
      if (requestId === undefined) return ok(snapshot);
      const old = tx.captureReceipt(requestId);
      if (old)
        return old.binding === binding && tx.changeset(old.hash)
          ? ok(tx.changeset(old.hash)!)
          : codingFailure('request_conflict');
      tx.putChangeset(snapshot);
      tx.putCaptureReceipt(requestId, { binding, hash: snapshot.hash });
      return ok(snapshot);
    });
  }
  /** Latest stored immutable changeset for a disabled task; never captures or executes. */
  history(access: CodingAccess): CodingResult<Changeset> {
    return this.#deps.store.atomic((tx) => {
      const task = this.#task(tx, access, true),
        snapshot = task ? tx.latestChangeset(task.id) : null;
      return task && snapshot ? ok(snapshot) : codingFailure('coding_denied');
    });
  }
  read(access: CodingAccess, hash: string): CodingResult<Changeset> {
    return this.#deps.store.atomic((tx) => {
      const task = this.#task(tx, access, true),
        snapshot = task ? tx.changeset(hash, task.id) : null;
      return task && snapshot?.taskId === task.id ? ok(snapshot) : codingFailure('coding_denied');
    });
  }
}
