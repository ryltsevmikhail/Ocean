import {
  codingFailure,
  ok,
  type CodingApplyResolution,
  type CodingApplyReceipt,
  type CodingTask,
  type Changeset,
  type CodingResult,
} from '@runnets/domain';
import type { CodingApplyTransaction } from './coding-apply.js';
import type { ToolEffectRecord } from './tools.js';
import type { Clock } from './ports.js';
export interface CodingApplyResolutionTransaction extends Pick<
  CodingApplyTransaction,
  'task' | 'worktree' | 'participates' | 'application' | 'changeset'
> {
  unresolved(): readonly ToolEffectRecord[];
  resolution(applicationId: string): CodingApplyResolution | null;
  putResolution(value: CodingApplyResolution): void;
}
export interface CodingApplyResolutionDeps {
  readonly ownerId: string;
  readonly clock: Clock;
  readonly admit: (task: CodingTask, tx: CodingApplyResolutionTransaction) => boolean;
}
export interface CodingApplyResolutionStore {
  atomic<T>(work: (tx: CodingApplyResolutionTransaction) => T): T;
}
export interface CodingApplyTreePort {
  tree(root: string, expectedBase: string): Promise<string>;
}
export interface CodingApplyResolutionOwnerPort {
  confirm(
    preview: Readonly<{
      task: CodingTask;
      receipt: CodingApplyReceipt;
      changeset: Changeset;
      accepted: 'before' | 'after';
      treeHash: string;
      reason: string;
    }>,
  ): Promise<boolean>;
}
/** No project mutation or replay: record a separate owner decision over an exact observed tree. */
export class CodingApplyResolutionService {
  readonly #store: CodingApplyResolutionStore;
  readonly #project: CodingApplyTreePort;
  readonly #deps: CodingApplyResolutionDeps;
  constructor(
    store: CodingApplyResolutionStore,
    project: CodingApplyTreePort,
    deps: CodingApplyResolutionDeps,
  ) {
    this.#store = store;
    this.#project = project;
    this.#deps = deps;
  }
  async reconcile(
    input: Readonly<{
      workspaceId: string;
      applicationId: string;
      accepted: 'before' | 'after';
      reason: string;
    }>,
    owner: CodingApplyResolutionOwnerPort,
  ): Promise<CodingResult<CodingApplyResolution>> {
    const i = { ...input, reason: input.reason.trim() };
    if (
      !i.applicationId ||
      !i.workspaceId ||
      !['before', 'after'].includes(i.accepted) ||
      !i.reason ||
      i.reason.length > 4096
    )
      return codingFailure('invalid_input');
    const resolve = (tx: CodingApplyResolutionTransaction) => {
      const receipt = tx.application(i.applicationId);
      if (
        !receipt ||
        receipt.id !== i.applicationId ||
        receipt.status !== 'uncertain' ||
        tx.resolution(i.applicationId)
      )
        return null;
      const task = tx.task(receipt.taskId),
        changeset = tx.changeset(receipt.changesetHash),
        effects = tx.unresolved(),
        effect = effects[0];
      if (
        !task ||
        task.workspaceId !== i.workspaceId ||
        task.lease.ownerId !== this.#deps.ownerId ||
        !this.#deps.admit(task, tx) ||
        !changeset ||
        changeset.taskId !== task.id ||
        changeset.hash !== receipt.changesetHash ||
        changeset.baseCommit !== receipt.expectedBase ||
        task.baseCommit !== receipt.expectedBase ||
        effects.length !== 1 ||
        !effect ||
        effect.id !== receipt.id ||
        effect.tool !== 'coding_apply' ||
        effect.taskRunId !== 'apply-' + receipt.id ||
        effect.attemptId !== 'apply' ||
        effect.outcome !== 'uncertain' ||
        JSON.stringify(receipt.files.map((file) => file.path)) !==
          JSON.stringify(changeset.files.map((file) => file.path))
      )
        return null;
      return structuredClone({ task, changeset, receipt, effect });
    };
    const prepared = this.#store.atomic(resolve);
    if (!prepared) return codingFailure('coding_denied');
    const expected =
      i.accepted === 'before'
        ? prepared.changeset.beforeTreeHash
        : prepared.changeset.afterTreeHash;
    const observe = () =>
      this.#project.tree(prepared.task.projectRoot, prepared.receipt.expectedBase);
    try {
      if ((await observe()) !== expected) return codingFailure('project_changed');
    } catch {
      return codingFailure('worktree_unavailable');
    }
    if (!this.#store.atomic((tx) => JSON.stringify(resolve(tx)) === JSON.stringify(prepared)))
      return codingFailure('coding_denied');
    const requestedAt = this.#deps.clock.now().getTime();
    if (!Number.isFinite(requestedAt)) return codingFailure('approval_required');
    if (
      !(await owner.confirm(
        structuredClone({
          ...prepared,
          accepted: i.accepted,
          treeHash: expected,
          reason: i.reason,
        }),
      ))
    )
      return codingFailure('approval_required');
    try {
      if ((await observe()) !== expected) return codingFailure('project_changed');
    } catch {
      return codingFailure('worktree_unavailable');
    }
    return this.#store.atomic((tx) => {
      const now = this.#deps.clock.now().getTime();
      if (!Number.isFinite(now) || now < requestedAt || now - requestedAt >= 300000)
        return codingFailure('approval_required');
      if (JSON.stringify(resolve(tx)) !== JSON.stringify(prepared))
        return codingFailure('coding_denied');
      const value: CodingApplyResolution = {
        applicationId: i.applicationId,
        taskId: prepared.task.id,
        workspaceId: i.workspaceId,
        changesetHash: prepared.changeset.hash,
        baseCommit: prepared.receipt.expectedBase,
        ownerId: this.#deps.ownerId,
        accepted: i.accepted,
        treeHash: expected,
        effectFingerprint: prepared.effect.fingerprint,
        reason: i.reason,
        decidedAt: new Date(now).toISOString(),
      };
      tx.putResolution(value);
      return ok(value);
    });
  }
}
