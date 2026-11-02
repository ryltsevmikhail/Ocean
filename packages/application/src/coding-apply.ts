import {
  codingApplicationVerified,
  codingFailure,
  ok,
  type CodingTask,
  type CodingWorktree,
  type Changeset,
  type CodingFileChange,
  type CodingReviewVerdict,
  type CodingTestEvidence,
  type CodingApplyReceipt,
  type CodingApplyContext,
  type CodingApplyResolution,
  type CodingResult,
} from '@runnets/domain';
export interface CodingApplyTransaction {
  worktree(taskId: string): CodingWorktree | null;
  participates(workspaceId: string, roomId: string, botId: string): boolean;
  task(id: string): CodingTask | null;
  changeset(hash: string): Changeset | null;
  verdict(requestId: string): CodingReviewVerdict | null;
  evidence(taskId: string): readonly CodingTestEvidence[];
  application(id: string): CodingApplyReceipt | null;
  resolution?(applicationId: string): CodingApplyResolution | null;
  pendingApplications(): readonly CodingApplyReceipt[];
  putApplication(receipt: CodingApplyReceipt): void;
  claimApplication(receipt: CodingApplyReceipt): boolean;
}
export interface CodingApplyStore {
  atomic<T>(work: (tx: CodingApplyTransaction) => T): T;
}
export interface CodingApplyProjectPort {
  inspect(root: string): Promise<{ readonly clean: boolean; readonly baseCommit: string }>;
  sourceTree(task: CodingTask): Promise<string>;
  applyFile(root: string, change: CodingFileChange, context: CodingApplyContext): Promise<void>;
}
export interface CodingApplyOwnerPort {
  confirm(
    preview: Readonly<{ task: CodingTask; changeset: Changeset; verdict: CodingReviewVerdict }>,
  ): Promise<boolean>;
}
/** Multi-file effects are recorded individually. Unknown results are never redispatched. */
export class CodingApplyService {
  readonly #store: CodingApplyStore;
  readonly #project: CodingApplyProjectPort;
  readonly #admit: (task: CodingTask, tx: CodingApplyTransaction) => boolean;
  constructor(
    store: CodingApplyStore,
    project: CodingApplyProjectPort,
    admit: (task: CodingTask, tx: CodingApplyTransaction) => boolean,
  ) {
    this.#store = store;
    this.#project = project;
    this.#admit = admit;
  }
  /** Exclusive runtime startup: preserve uncertainty without observing or replaying effects. */
  recover(): readonly CodingApplyReceipt[] {
    return this.#store.atomic((tx) =>
      tx.pendingApplications().map((previous) => {
        const receipt: CodingApplyReceipt = {
          ...previous,
          status: 'uncertain',
          files: previous.files.map((file) =>
            file.status === 'started' ? { ...file, status: 'uncertain' } : file,
          ),
        };
        tx.putApplication(receipt);
        return receipt;
      }),
    );
  }
  async apply(
    input: Readonly<{
      id: string;
      workspaceId: string;
      taskId: string;
      changesetHash: string;
      reviewRequestId: string;
      expectedBase: string;
    }>,
    owner: CodingApplyOwnerPort,
  ): Promise<CodingResult<CodingApplyReceipt>> {
    const i = structuredClone(input);
    const resolve = (tx: CodingApplyTransaction) => {
      const task = tx.task(i.taskId),
        changeset = tx.changeset(i.changesetHash),
        verdict = tx.verdict(i.reviewRequestId);
      if (
        !task ||
        task.workspaceId !== i.workspaceId ||
        !this.#admit(task, tx) ||
        !changeset ||
        !verdict ||
        i.expectedBase !== changeset.baseCommit ||
        !codingApplicationVerified(task, changeset, verdict, tx.evidence(task.id))
      )
        return null;
      return { task, changeset, verdict };
    };
    const prepared = this.#store.atomic((tx) => (tx.application(i.id) ? null : resolve(tx)));
    if (!prepared) return codingFailure('coding_denied');
    const validProject = async () => {
      const project = await this.#project.inspect(prepared.task.projectRoot);
      return (
        project.clean &&
        project.baseCommit === i.expectedBase &&
        (await this.#project.sourceTree(prepared.task)) === prepared.changeset.afterTreeHash
      );
    };
    if (!(await validProject())) return codingFailure('project_changed');
    if (!(await owner.confirm(structuredClone(prepared))))
      return codingFailure('approval_required');
    if (!(await validProject())) return codingFailure('project_changed');
    const claimed = this.#store.atomic((tx) => {
      if (tx.application(i.id) || !resolve(tx)) return null;
      const receipt: CodingApplyReceipt = {
        recoveryProtocol: 2,
        id: i.id,
        taskId: i.taskId,
        changesetHash: i.changesetHash,
        reviewRequestId: i.reviewRequestId,
        expectedBase: i.expectedBase,
        status: 'applying',
        files: prepared.changeset.files.map((file) => ({ path: file.path, status: 'pending' })),
      };
      if (!tx.claimApplication(receipt)) return null;
      tx.putApplication(receipt);
      return receipt;
    });
    if (!claimed) return codingFailure('recovery_required');
    let receipt = claimed;
    try {
      // The shared claim now excludes another runtime writer during observation.
      if (!(await validProject())) {
        receipt = { ...receipt, status: 'not_started' };
        this.#store.atomic((tx) => tx.putApplication(receipt));
        return codingFailure('project_changed');
      }
      // Delete obsolete descendants before adding a file at their former parent.
      const ordered = [...prepared.changeset.files.entries()].sort(
        ([, a], [, b]) =>
          Number(a.after !== null) - Number(b.after !== null) ||
          (a.after === null
            ? b.path.split('/').length - a.path.split('/').length
            : a.path.split('/').length - b.path.split('/').length) ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      for (const [index, file] of ordered) {
        receipt = {
          ...receipt,
          files: receipt.files.map((entry, n) =>
            n === index ? { ...entry, status: 'started' } : entry,
          ),
        };
        this.#store.atomic((tx) => tx.putApplication(receipt));
        await this.#project.applyFile(prepared.task.projectRoot, file, {
          ownerId: prepared.task.lease.ownerId,
          taskId: prepared.task.id,
          applicationId: receipt.id,
          changesetHash: prepared.changeset.hash,
        });
        receipt = {
          ...receipt,
          files: receipt.files.map((entry, n) =>
            n === index ? { ...entry, status: 'completed' } : entry,
          ),
        };
        this.#store.atomic((tx) => tx.putApplication(receipt));
      }
      receipt = { ...receipt, status: 'completed' };
      this.#store.atomic((tx) => tx.putApplication(receipt));
      return ok(receipt);
    } catch {
      receipt = {
        ...receipt,
        status: 'uncertain',
        files: receipt.files.map((entry) =>
          entry.status === 'started' ? { ...entry, status: 'uncertain' } : entry,
        ),
      };
      this.#store.atomic((tx) => tx.putApplication(receipt));
      return codingFailure('recovery_required');
    }
  }
}
