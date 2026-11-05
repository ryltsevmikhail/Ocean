import type {
  BroadcastBatch,
  ChatTurn,
  ChatReview,
  RoomExecutionPolicy,
  RoomModelPolicy,
  Bot,
  BotModelBinding,
  BoundBot,
  BotProfileInput,
  ConversationMessage,
  DirectRoom,
  Room,
  Workspace,
} from '@runnets/domain';

interface Request {
  readonly requestId: string;
  readonly workspaceId: string;
}
export type ConversationCommand =
  | (Request & { readonly type: 'BindWorkspace'; readonly root: string })
  | (Request & BotProfileInput & { readonly type: 'CreateBot' })
  | (Request & { readonly type: 'OpenDirectRoom'; readonly botId: string })
  | (Request & {
      readonly type: 'CreateGroupRoom';
      readonly title: string;
      readonly botIds: readonly string[];
    })
  | (Request & {
      readonly type: 'RecordUserMessage';
      readonly roomId: string;
      readonly text: string;
    });
export type ConversationReply =
  | { readonly kind: 'workspace'; readonly data: Workspace }
  | { readonly kind: 'bot'; readonly data: Bot }
  | { readonly kind: 'room'; readonly data: Room }
  | { readonly kind: 'message'; readonly data: ConversationMessage }
  | { readonly kind: 'turn'; readonly data: ChatTurn }
  | { readonly kind: 'review'; readonly data: ChatReview };
export interface ConversationReceipt {
  readonly binding: string;
  readonly reply:
    | ConversationReply
    | { readonly kind: 'room_model_policy'; readonly data: RoomModelPolicy }
    | { readonly kind: 'bound_bot'; readonly data: BoundBot }
    | {
        readonly kind: 'review_request';
        readonly data: {
          readonly id: string;
          readonly workspaceId: string;
          readonly roomId: string;
          readonly taskRunId: string;
        };
      };
}
/** Synchronous transaction surface; implementations must roll back writes on exceptions. */
export interface ConversationTransaction {
  /**
   * Optional fail-closed publication evidence. Head and complete unresolved effects
   * (this run plus unscoped legacy) MUST share this authoritative transaction/write
   * lock with putChatTurn. Unrelated adapters or incomplete evidence return null.
   */
  chatFailureEvidence?(taskRunId: string): {
    readonly taskVersion: number;
    readonly relatedPendingEffects: number;
  } | null;

  roomModelPolicy(roomId: string): RoomModelPolicy | null;
  putRoomModelPolicy(policy: RoomModelPolicy): void;
  review(id: string): ChatReview | null;
  putReview(review: ChatReview): void;
  roomPolicy(roomId: string): RoomExecutionPolicy | null;
  putRoomPolicy(policy: RoomExecutionPolicy): void;
  chatTurn(id: string): ChatTurn | null;
  roomChatRun(workspaceId: string, roomId: string, runId: string): ChatTurn | null;
  chatTurns(): readonly ChatTurn[];
  activeChatTurn(roomId: string): ChatTurn | null;
  putChatTurn(turn: ChatTurn): void;
  workspace(): Workspace | null;
  putWorkspace(workspace: Workspace): void;
  bot(id: string): Bot | null;
  botByHandle(handle: string): Bot | null;
  bots(): readonly Bot[];
  putBot(bot: Bot): void;
  /** Compare and replace an existing profile; never insert. */
  replaceBot(bot: Bot, expectedProfileVersion: number): void;
  modelBinding(botId: string): BotModelBinding | null;
  putModelBinding(botId: string, binding: BotModelBinding): void;
  room(id: string): Room | null;
  rooms(): readonly Room[];
  directRoom(botId: string): DirectRoom | null;
  putRoom(room: Room): void;
  history(roomId: string, after: number, limit: number): readonly ConversationMessage[];
  nextSequence(roomId: string): number;
  putMessage(message: ConversationMessage): void;
  receipt(requestId: string): ConversationReceipt | null;
  putReceipt(requestId: string, receipt: ConversationReceipt): void;
  /** Durable broadcast batch, its frozen children and the room's open/paused batch. */
  broadcastBatch(id: string): BroadcastBatch | null;
  broadcastBatchByRequest(requestId: string): BroadcastBatch | null;
  broadcastBatchForRoom(roomId: string): BroadcastBatch | null;
  broadcastBatches(roomId: string, limit: number): readonly BroadcastBatch[];
  /** Batches that still hold their room (open or awaiting an owner decision). */
  broadcastOpenBatches(): readonly BroadcastBatch[];
  putBroadcastBatch(batch: BroadcastBatch): void;
  broadcastTurns(batchId: string): readonly ChatTurn[];
  completeReviewRequest(
    requestId: string,
    decisionId: string,
    binding: string,
    review: ChatReview,
  ): void;
}
export interface ConversationStore {
  /** Commit data and receipt together, without asynchronous suspension. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T;
}
