import {
  classifyCodingApplyFile,
  codingFailure,
  ok,
  type CodingApplyFileObservation,
  type CodingApplyFileComparison,
  type CodingApplyReceipt,
  type CodingApplyResolution,
  type CodingTask,
  type CodingResult,
} from '@runnets/domain';
import type { CodingApplyStore, CodingApplyTransaction } from './coding-apply.js';
export interface CodingApplyObservationPort {
  observe(root: string, paths: readonly string[]): Promise<readonly CodingApplyFileObservation[]>;
}
export interface CodingApplyInspection {
  readonly receipt: CodingApplyReceipt;
  readonly projectRoot: string;
  readonly holdReleased: false;
  readonly resolution: CodingApplyResolution | null;
  readonly files: readonly (CodingApplyFileObservation & {
    readonly comparison: CodingApplyFileComparison;
  })[];
}
/** Diagnostic reads are not recovery decisions and cannot settle or repeat an effect. */
export class CodingApplyInspectionService {
  readonly #store: CodingApplyStore;
  readonly #project: CodingApplyObservationPort;
  readonly #admit: (task: CodingTask, tx: CodingApplyTransaction) => boolean;
  constructor(
    store: CodingApplyStore,
    project: CodingApplyObservationPort,
    admit: (task: CodingTask, tx: CodingApplyTransaction) => boolean,
  ) {
    this.#store = store;
    this.#project = project;
    this.#admit = admit;
  }
  async inspect(
    input: Readonly<{ workspaceId: string; applicationId: string }>,
  ): Promise<CodingResult<CodingApplyInspection>> {
    const i = { ...input };
    if (
      !i.workspaceId ||
      !i.applicationId ||
      i.applicationId.length > 4096 ||
      i.applicationId.includes('\0')
    )
      return codingFailure('invalid_input');
    const resolve = (tx: CodingApplyTransaction) => {
      const receipt = tx.application(i.applicationId);
      if (!receipt || receipt.id !== i.applicationId) return null;
      const task = tx.task(receipt.taskId),
        changeset = tx.changeset(receipt.changesetHash);
      if (
        !task ||
        task.workspaceId !== i.workspaceId ||
        !this.#admit(task, tx) ||
        !changeset ||
        changeset.hash !== receipt.changesetHash ||
        changeset.taskId !== task.id ||
        changeset.baseCommit !== receipt.expectedBase ||
        task.baseCommit !== receipt.expectedBase ||
        JSON.stringify(receipt.files.map((file) => file.path)) !==
          JSON.stringify(changeset.files.map((file) => file.path))
      )
        return null;
      return structuredClone({
        receipt,
        task,
        changeset,
        resolution: tx.resolution?.(receipt.id) ?? null,
      });
    };
    const prepared = this.#store.atomic(resolve);
    if (!prepared) return codingFailure('coding_denied');
    let actual: readonly CodingApplyFileObservation[];
    try {
      actual = await this.#project.observe(
        prepared.task.projectRoot,
        prepared.changeset.files.map((file) => file.path),
      );
    } catch {
      return codingFailure('worktree_unavailable');
    }
    if (!this.#store.atomic((tx) => JSON.stringify(resolve(tx)) === JSON.stringify(prepared)))
      return codingFailure('coding_denied');
    if (
      actual.length !== prepared.changeset.files.length ||
      actual.some((value, index) => value.path !== prepared.changeset.files[index]!.path)
    )
      return codingFailure('worktree_unavailable');
    return ok({
      receipt: prepared.receipt,
      projectRoot: prepared.task.projectRoot,
      holdReleased: false,
      resolution: prepared.resolution,
      files: actual.map((value, index) => ({
        ...value,
        comparison: classifyCodingApplyFile(
          prepared.changeset.files[index]!,
          value,
          prepared.changeset.files,
        ),
      })),
    });
  }
}
