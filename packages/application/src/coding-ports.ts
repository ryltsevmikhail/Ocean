import type {
  CodingTask,
  CodingPolicy,
  CodingResult,
  ProjectLease,
  ProjectLeaseHolder,
} from '@runnets/domain';
export interface CodingReceipt {
  readonly binding: string;
  readonly taskId: string;
}
export interface CodingTransaction {
  task(id: string): CodingTask | null;
  putTask(task: CodingTask): void;
  receipt(id: string): CodingReceipt | null;
  putReceipt(id: string, receipt: CodingReceipt): void;
  participates(workspaceId: string, roomId: string, botId: string): boolean;
  workspaceRoot(workspaceId: string): string | null;
}
export interface CodingStore {
  atomic<T>(work: (tx: CodingTransaction) => T): T;
}
export interface ProjectLeasePort {
  acquire(projectRoot: string, holder: ProjectLeaseHolder): CodingResult<ProjectLease>;
  owns(lease: ProjectLease): boolean;
  release(lease: ProjectLease): boolean;
}
export interface CodingProjectPort {
  inspect(
    path: string,
  ): Promise<{ readonly root: string; readonly baseCommit: string; readonly clean: boolean }>;
}
export interface StartCodingTask {
  readonly taskId: string;
  readonly requestId: string;
  readonly workspaceId: string;
  readonly projectRoot: string;
  readonly ownerRoomId: string;
  readonly reviewRoomId: string;
  readonly devBotId: string;
  readonly reviewBotId: string;
  readonly devCapabilities: CodingPolicy['devCapabilities'];
  readonly testPresets: CodingPolicy['testPresets'];
}
/** An in-process owner interface; model messages and wire booleans cannot supply this authority. */
export interface CodingOwnerPort {
  confirm(
    preview: Readonly<{
      operation: 'reserve' | 'cancel';
      workspaceId: string;
      ownerRoomId: string;
      devBotId: string;
      reviewRoomId: string;
      reviewBotId: string;
      baseCommit: string;
      taskId: string;
      projectRoot: string;
      policy: CodingPolicy;
    }>,
  ): Promise<boolean>;
}
