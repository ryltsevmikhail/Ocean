import {
  taskRunId,
  isValidId,
  type Bot,
  type ChatTurnStatus,
  type ConversationMessage,
  type Sensitivity,
  type TaskRunStatus,
} from '@runnets/domain';
import type { ChatRoomScope, RunQuery } from './chat-receipts.js';
import type { TaskRunService } from './service.js';

export interface RoomRunState extends RunQuery {
  requestId: string;
  turnId: string;
  messageId: string;
  performerId: string;
  turnStatus: ChatTurnStatus;
  taskStatus: TaskRunStatus | 'admitted_before_run' | 'not_created';
  version: number;
  resultMessageId: string | null;
  pendingDecisionIds: readonly string[];
}
export interface RoomSummary {
  workspaceId: string;
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  botId: string | null;
}
export type MemberSummary = Pick<
  Bot,
  'workspaceId' | 'id' | 'handle' | 'name' | 'model' | 'provider'
> & {
  roomId: string;
};
export interface RoomRunEvent {
  sequence: number;
  type: string;
  sensitivity: Sensitivity;
}
export interface RoomRunReadPort {
  rooms(workspaceId: string, after: string, limit: number): readonly RoomSummary[];
  members(scope: ChatRoomScope, after: string, limit: number): readonly MemberSummary[];
  history(scope: ChatRoomScope, after: number, limit: number): Iterable<ConversationMessage>;
  runs(scope: ChatRoomScope, after: string, limit: number): Iterable<RoomRunState>;
  cancelTarget(query: RunQuery): Pick<RoomRunState, 'turnStatus' | 'version'> | null;
  run(query: RunQuery): RoomRunState | null;
  hasPositions(scope: ChatRoomScope | RunQuery, after: number, through: number): boolean;
  decisionRevision?(scope: ChatRoomScope): number;
  roomSequence(scope: ChatRoomScope): number;
  events(query: RunQuery, after: number, limit: number): readonly RoomRunEvent[];
  result(query: RunQuery): ConversationMessage | null;
}
export interface RoomCancelRequest extends RunQuery {
  requestId: string;
  expectedVersion: number;
}

/** A host may signal only the controller of an exact, committed cancellation. */
export class RoomRuntimeRuns {
  readonly reads: RoomRunReadPort;
  readonly #tasks: TaskRunService;
  constructor(reads: RoomRunReadPort, tasks: TaskRunService) {
    this.reads = reads;
    this.#tasks = tasks;
  }
  async cancel(input: RoomCancelRequest, controller: AbortController | undefined) {
    const { workspaceId, roomId, runId, requestId, expectedVersion } = input;
    const state = this.reads.cancelTarget({ workspaceId, roomId, runId });
    const commandId = 'room-cancel-' + requestId;
    // Include the room and workspace in the durable command identity binding, not in its key.
    const command = {
      type: 'RequestCancel',
      commandId,
      taskRunId: runId,
      expectedVersion,
      actor: { kind: 'user', id: 'owner' },
      payload: { cause: JSON.stringify(['room_cancel', workspaceId, roomId]) },
    } as const;
    const previous = await this.#tasks.lookupCommand(command);
    if (!previous.ok) throw Error('request_conflict');
    if (!state || !isValidId(runId, 'tr')) throw Error('unknown_run');
    const receipt = (version: number) => ({
      workspaceId,
      roomId,
      runId,
      requestId,
      expectedVersion,
      version,
      status: 'requested' as const,
    });
    if (previous.value) return receipt(previous.value.version);
    if (!controller || !['accepted', 'dispatching'].includes(state.turnStatus))
      throw Error('run_not_active');
    if (state.version !== expectedVersion) throw Error('version_conflict');
    if (state.version === 0) throw Error('run_not_started');
    const committed = await this.#tasks.execute({ ...command, taskRunId: taskRunId(runId) });
    if (!committed.ok)
      throw Error(
        committed.error.code === 'invalid_argument' ? 'request_conflict' : committed.error.code,
      );
    controller.abort();
    return receipt(committed.value.version);
  }
}
