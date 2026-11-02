import type {
  ChatTurn,
  Bot,
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
  | { readonly kind: 'turn'; readonly data: ChatTurn };
export interface ConversationReceipt {
  readonly binding: string;
  readonly reply: ConversationReply;
}
/** Synchronous transaction surface; implementations must roll back writes on exceptions. */
export interface ConversationTransaction {
  chatTurn(id: string): ChatTurn | null;
  chatTurns(): readonly ChatTurn[];
  activeChatTurn(roomId: string): ChatTurn | null;
  putChatTurn(turn: ChatTurn): void;
  workspace(): Workspace | null;
  putWorkspace(workspace: Workspace): void;
  bot(id: string): Bot | null;
  botByHandle(handle: string): Bot | null;
  bots(): readonly Bot[];
  putBot(bot: Bot): void;
  room(id: string): Room | null;
  rooms(): readonly Room[];
  directRoom(botId: string): DirectRoom | null;
  putRoom(room: Room): void;
  history(roomId: string, after: number, limit: number): readonly ConversationMessage[];
  nextSequence(roomId: string): number;
  putMessage(message: ConversationMessage): void;
  receipt(requestId: string): ConversationReceipt | null;
  putReceipt(requestId: string, receipt: ConversationReceipt): void;
}
export interface ConversationStore {
  /** Commit data and receipt together, without asynchronous suspension. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T;
}
