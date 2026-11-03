import type {
  CodingTask,
  RestoreOrigin,
  ProfileRebindHold,
  ProfileRebindPreview,
  ProfileRebindSelection,
  ProfileRebindPlan,
  ProfileRebindRecord,
  ProfileRebindMaterialization,
  ProfileRebindObservation,
} from '@runnets/domain';
export interface ProfileRebindTransaction {
  observe(value: ProfileRebindObservation): void;
  origin(): RestoreOrigin | null;
  task(id: string): CodingTask | null;
  participates(workspaceId: string, roomId: string, botId: string): boolean;
  holds(): readonly ProfileRebindHold[];
  record(requestId: string): ProfileRebindRecord | null;
  busy(): boolean;
  save(value: ProfileRebindRecord, expectedRevision: number | null): boolean;
  /** Atomic new authority publication; old records are never overwritten. */
  publish(value: ProfileRebindRecord, materialization: ProfileRebindMaterialization): void;
}
export interface ProfileRebindStore {
  active(): ProfileRebindRecord | null;
  atomic<T>(work: (tx: ProfileRebindTransaction) => T): T;
  /** Lower interrupted operations to held, never replay or infer a successful effect. */
  recover(): void;
}
export interface ProfileRebindFiles {
  inspect(input: {
    readonly origin: RestoreOrigin;
    readonly task: CodingTask;
    readonly selection: ProfileRebindSelection;
    readonly epochId: string;
    readonly ownerId: string;
    readonly successorTaskId: string;
  }): Promise<ProfileRebindPlan>;
  prepare(confirmed: ProfileRebindRecord): Promise<ProfileRebindMaterialization>;
  verify(preview: ProfileRebindPreview, result: ProfileRebindMaterialization): Promise<void>;
}
