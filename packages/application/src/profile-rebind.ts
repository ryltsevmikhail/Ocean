import { validateRebindResult } from './profile-rebind-result.js';
import {
  validCodingBackupPolicy,
  type ProfileRebindSelection,
  type ProfileRebindRecord,
  type ProfileRebindPreview,
} from '@runnets/domain';
import type {
  ProfileRebindFiles,
  ProfileRebindStore,
  ProfileRebindTransaction,
} from './profile-rebind-ports.js';
import type { ProjectLeasePort } from './coding-ports.js';
import { validCodingStart } from './coding-validation.js';
import type { RuntimeOwnerDecisions, OwnerDecision } from './owner-decisions.js';
export interface ProfileRebindDeps {
  readonly store: ProfileRebindStore;
  readonly files: ProfileRebindFiles;
  readonly leases: ProjectLeasePort;
  readonly owner: RuntimeOwnerDecisions;
  readonly now: () => number;
  readonly nextId: () => string;
  readonly digest: (text: string) => string;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A restored graph becomes fresh authority only through a live exact owner decision and durable CAS. */
export class ProfileRebindService {
  readonly #d: ProfileRebindDeps;
  readonly #jobs = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  #failure: unknown;
  #reason(error: unknown): Error {
    return error instanceof Error ? error : Error('rebind_unavailable');
  }
  constructor(deps: ProfileRebindDeps) {
    this.#d = deps;
    deps.store.recover();
  }
  #select(tx: ProfileRebindTransaction, i: ProfileRebindSelection) {
    const origin = tx.origin(),
      task = tx.task(i.taskId);
    if (
      !origin ||
      !task ||
      origin.profileId !== i.profileId ||
      origin.snapshotId !== i.snapshotId ||
      task.workspaceId !== i.workspaceId ||
      task.ownerRoomId !== i.roomId ||
      task.lease.ownerId !== i.sourceOwnerId ||
      !origin.sourceOwners.includes(i.sourceOwnerId) ||
      task.baseCommit !== i.baseCommit ||
      task.status !== 'reserved' ||
      task.worktreeRoot === null ||
      !tx.participates(task.workspaceId, task.ownerRoomId, task.devBotId) ||
      !tx.participates(task.workspaceId, task.reviewRoomId, task.reviewBotId)
    )
      throw Error('rebind_scope_conflict');
    if (
      !validCodingBackupPolicy(1, i.policy) ||
      !validCodingStart({
        ...task,
        taskId: task.id,
        requestId: i.requestId,
        projectRoot: i.projectRoot,
        devCapabilities: i.policy.devCapabilities,
        testPresets: i.policy.testPresets,
      }) ||
      !/^[a-f0-9]{64}$/.test(i.treeHash)
    )
      throw Error('invalid_input');
    const holds = tx.holds();
    if (holds.some((h) => h.scope === 'global')) throw Error('rebind_effects_held');
    return { origin, task, holds };
  }
  #ref(r: ProfileRebindRecord) {
    return {
      workspaceId: r.preview.selection.workspaceId,
      roomId: r.preview.selection.roomId,
      runId: 'rebind-' + r.preview.epochId,
      decisionId: r.decisionId,
    };
  }
  result(i: ProfileRebindSelection): ProfileRebindRecord {
    const r = this.#d.store.atomic((tx) => tx.record(i.requestId));
    if (!r || !equal(r.preview.selection, i)) throw Error('rebind_request_conflict');
    return structuredClone(r);
  }
  async #current(p: ProfileRebindPreview): Promise<boolean> {
    try {
      const current = this.#d.store.atomic((tx) => this.#select(tx, p.selection));
      if (!equal(current, { origin: p.origin, task: p.originalTask, holds: p.holds })) return false;
      const plan = await this.#d.files.inspect({
        origin: p.origin,
        task: p.originalTask,
        selection: p.selection,
        epochId: p.epochId,
        ownerId: p.ownerId,
        successorTaskId: p.successorTaskId,
      });
      return (
        equal(plan, p.plan) &&
        plan.project.root === p.selection.projectRoot &&
        plan.project.baseCommit === p.selection.baseCommit &&
        plan.project.treeHash === p.selection.treeHash
      );
    } catch {
      return false;
    }
  }
  async preview(input: ProfileRebindSelection): Promise<OwnerDecision> {
    if (this.#failure) throw this.#reason(this.#failure);
    this.#closing.signal.throwIfAborted();
    const i = structuredClone(input);
    const old = this.#d.store.atomic((tx) => tx.record(i.requestId));
    if (old) {
      if (!equal(old.preview.selection, i)) throw Error('rebind_request_conflict');
      return this.#d.owner.get(this.#ref(old));
    }
    const selected = this.#d.store.atomic((tx) => {
      const value = this.#select(tx, i);
      if (tx.busy()) throw Error('rebind_in_progress');
      return value;
    });
    const epochId = this.#d.nextId(),
      successorTaskId = this.#d.nextId();
    const ownerId = i.profileId + ':' + epochId;
    const plan = await this.#d.files.inspect({
      ...selected,
      selection: i,
      epochId,
      ownerId,
      successorTaskId,
    });
    if (
      plan.project.root !== i.projectRoot ||
      plan.project.baseCommit !== i.baseCommit ||
      plan.project.treeHash !== i.treeHash
    )
      throw Error('rebind_project_changed');
    const preview: ProfileRebindPreview = {
      selection: i,
      origin: selected.origin,
      originalTask: selected.task,
      epochId,
      ownerId,
      successorTaskId,
      plan,
      holds: selected.holds,
      postSnapshotInterval: 'unknown-never-replayed',
    };
    if (!(await this.#current(preview))) throw Error('rebind_inputs_changed');
    const text = JSON.stringify(preview),
      createdAt = this.#d.now();
    if (text.length > 33554432 || !Number.isSafeInteger(createdAt)) throw Error('invalid_input');
    const record: ProfileRebindRecord = {
      requestId: i.requestId,
      revision: 1,
      decisionId: this.#d.nextId(),
      bindingDigest: this.#d.digest(text),
      preview,
      createdAt,
      expiresAt: createdAt + 300000,
      state: 'preview',
      projectLease: null,
      worktreeLease: null,
      result: null,
      reason: null,
    };
    const card: OwnerDecision = {
      ...this.#ref(record),
      kind: 'restore-rebind',
      status: 'pending',
      version: 1,
      bindingDigest: record.bindingDigest,
      createdAt,
      expiresAt: record.expiresAt,
      previewLength: text.length,
    };
    const wait = this.#d.owner.open(
      card,
      text,
      this.#closing.signal,
      () => this.#current(preview),
      (insert) => {
        this.#d.store.atomic((tx) => {
          this.#select(tx, i);
          if (tx.busy() || tx.task(successorTaskId) || !tx.save(record, null))
            throw Error('rebind_in_progress');
          insert();
        });
      },
    );
    const job = wait
      .then(async (outcome) => {
        if (outcome !== 'allowed') {
          this.#update(record, { state: 'refused', reason: outcome });
          return;
        }
        await this.#execute(record);
      })
      .catch((error: unknown) => {
        try {
          const current = this.#d.store.atomic((tx) => tx.record(i.requestId));
          if (current && !['ready', 'refused', 'held'].includes(current.state))
            this.#update(current, {
              state: current.state === 'preview' ? 'refused' : 'held',
              reason: error instanceof Error ? error.message : 'rebind_outcome_unknown',
            });
        } catch (failure) {
          this.#failure = failure;
        }
      })
      .finally(() => this.#jobs.delete(job));
    this.#jobs.add(job);
    return card;
  }
  #update(r: ProfileRebindRecord, fields: Partial<ProfileRebindRecord>): ProfileRebindRecord {
    const next = { ...r, ...fields, revision: r.revision + 1 };
    return this.#d.store.atomic((tx) => {
      if (!tx.save(next, r.revision)) throw Error('rebind_conflict');
      return next;
    });
  }
  async #execute(r: ProfileRebindRecord) {
    const p = r.preview;
    if (!(await this.#current(p))) throw Error('rebind_inputs_changed');
    r = this.#d.store.atomic((tx) => {
      this.#select(tx, p.selection);
      const card = this.#d.owner.store.find(this.#ref(r));
      const now = this.#d.now();
      if (
        !card ||
        card.status !== 'allowed' ||
        card.bindingDigest !== r.bindingDigest ||
        card.version !== 2 ||
        now < r.createdAt ||
        now >= r.expiresAt ||
        this.#closing.signal.aborted ||
        tx.busy() ||
        tx.task(p.successorTaskId)
      )
        throw Error('rebind_confirmation_inactive');
      const next = { ...r, revision: r.revision + 1, state: 'confirmed' as const };
      if (!tx.save(next, r.revision)) throw Error('rebind_conflict');
      return next;
    });
    const holder = {
      ownerId: p.ownerId,
      taskId: p.successorTaskId,
      requestId: 'rebind-' + r.requestId,
      binding: r.bindingDigest,
      kind: 'coding' as const,
    };
    const project = this.#d.leases.acquire(p.plan.project.root, holder);
    if (!project.ok) throw Error(project.error.code);
    r = this.#update(r, { projectLease: project.value });
    const worktree = this.#d.leases.acquire(p.plan.worktree.root, {
      ...holder,
      requestId: 'rebind-worktree-' + r.requestId,
    });
    if (!worktree.ok) throw Error(worktree.error.code);
    r = this.#update(r, { state: 'preparing', worktreeLease: worktree.value });
    if (!(await this.#current(p))) throw Error('rebind_inputs_changed');
    const result = await this.#d.files.prepare(structuredClone(r));
    validateRebindResult(r, result);
    await this.#d.files.verify(p, result);
    if (!(await this.#current(p))) throw Error('rebind_inputs_changed');
    this.#d.store.atomic((tx) => {
      this.#select(tx, p.selection);
      if (
        tx.record(r.requestId)?.revision !== r.revision ||
        !this.#d.leases.owns(project.value) ||
        !this.#d.leases.owns(worktree.value)
      )
        throw Error('rebind_conflict');
      tx.publish({ ...r, revision: r.revision + 1, state: 'ready', result }, result);
    });
  }
  async join() {
    await Promise.all([...this.#jobs]);
    if (this.#failure) throw this.#reason(this.#failure);
  }
  async close() {
    this.#closing.abort();
    await this.join();
  }
}
