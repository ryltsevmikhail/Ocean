import type { CommandReceipt } from './ports.js';
import type {
  ChatTurn,
  Command,
  TaskRunEvent,
  CodingTask,
  ModelExecutionIdentity,
  OwnerGrantReference,
  OwnerPermission,
  OwnerScopeGrant,
  RoomDeliveryAddress,
  RoomTaskAddress,
  TaskRunState,
} from '@runnets/domain';
import type { ModelConnectionRecord } from './model-connection-ports.js';
export type RoomTaskMandate = Readonly<{
  projectId: string | null;
  codingTaskId: string | null;
  permissions: readonly OwnerPermission[];
}>;
export type RoomTaskMemberPin = Readonly<{
  botId: string;
  grantReferences: readonly OwnerGrantReference[];
  identity: Extract<ModelExecutionIdentity, { source: 'connection' }>;
}>;
export type RoomTaskRootPayload = Readonly<{
  ownerId: string;
  mandate: RoomTaskMandate;
  members: readonly RoomTaskMemberPin[];
  limits: Readonly<{ concurrentSlices: 2; totalSlices: 32; providerStarts: 64; toolCalls: 64 }>;
}>;
type TaskRow = Readonly<{
  version: 1;
  revision: number;
  id: string;
  workspaceId: string;
  roomId: string;
  rootId: string;
  status: RoomTaskAddress['status'];
}>;
export type RoomTaskRoot = TaskRow &
  Readonly<{
    kind: 'root';
    parentId: null;
    assigneeBotId: null;
    lastDeliverySeq: 0;
    waitingChildId: null;
    rootPayload: RoomTaskRootPayload;
  }>;
export type RoomTaskBot = TaskRow &
  Readonly<{
    kind: 'bot';
    parentId: string;
    assigneeBotId: string;
    lastDeliverySeq: number;
    waitingChildId: string | null;
    rootPayload: null;
  }>;
export type RoomTaskRecord = RoomTaskRoot | RoomTaskBot;
export type RoomDeliveryRecord = RoomDeliveryAddress &
  Readonly<{
    version: 1;
    position: number;
    sourceAttemptId: string | null;
    state: 'queued' | 'claimed' | 'consumed' | 'held';
  }>;
export type RoomTaskOriginFacts = Readonly<{
  root: RoomTaskRoot;
  task: RoomTaskBot;
  input: RoomDeliveryRecord;
  turn: ChatTurn;
  liveRun: TaskRunState | null;
}>;
export type RoomCompleteEvidence = Readonly<{
  run: TaskRunState;
  headEvent: TaskRunEvent;
  receipt: CommandReceipt | null;
}>;
export type RoomRunEvidence =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'created';
      run: TaskRunState;
      headEvent: TaskRunEvent;
    }>;
export interface RoomTaskTransaction {
  delivery(id: string): RoomDeliveryRecord | null;
  inputs(taskId: string): readonly RoomDeliveryRecord[];
  tasks(rootId: string): readonly RoomTaskRecord[];
  claim(id: string): void;
  consume(id: string): void;
  advanceTask(task: RoomTaskRecord, expectedRevision: number): void;
  completeEvidence(command: Command<'Complete'>): RoomCompleteEvidence | null;
  unstartedEvidence(command: Command<'CreateTaskRun'>): RoomRunEvidence | null;
  task(id: string): RoomTaskRecord | null;
  /** Complete key evidence, including contradictory message IDs; never hide mixed-key rows. */
  deliveriesForReceipt(key: string, messageId: string): readonly RoomDeliveryRecord[];
  origin(
    turnId: string,
    runId: string,
    attemptId: string,
    live: boolean | 'settled',
  ): RoomTaskOriginFacts | null;
  grant(id: string): OwnerScopeGrant | null;
  modelConnection(id: string): ModelConnectionRecord | null;
  codingTask(id: string): CodingTask | null;
  restored(): boolean;
  roomHold(roomId: string): boolean;
  pendingTransfer(roomId: string): boolean;
  putTask(row: RoomTaskRecord): void;
  putDelivery(row: RoomDeliveryRecord): void;
  waitFor(taskId: string, childId: string, expectedRevision: number): void;
}
export type RoomTaskStart = Readonly<{
  workspaceId: string;
  roomId: string;
  requestId: string;
  text: string;
  initialBotIds: readonly string[];
  participants: readonly Readonly<{
    botId: string;
    grantReferences: readonly OwnerGrantReference[];
  }>[];
  mandate: RoomTaskMandate;
}>;
export type RoomTaskActor = Readonly<{
  turnId: string;
  taskRunId: string;
  attemptId: string;
  callId: string;
}>;
export type RoomTaskReceipt = Readonly<{
  version: 1;
  workspaceId: string;
  roomId: string;
  rootId: string;
  messageId: string;
  seq: number;
  deliveries: readonly Readonly<{ botId: string; taskId: string; deliveryId: string }>[];
}>;
