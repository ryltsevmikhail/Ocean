import { conversationFailure, ok, type ChatTurn, type ConversationResult } from '@runnets/domain';
import {
  admitChat,
  type DirectChatRequest,
  type ChatAdmissionMode,
  type ChatProviderSource,
} from './direct-chat-admission.js';
import type { ChatReviewService } from './chat-review.js';
import { recoverChats } from './direct-chat-publication.js';
import {
  executeChatTurn,
  type ChatCodingTools,
  type GrantedPluginTools,
} from './chat-turn-execution.js';
import type { ConversationServiceDeps } from './conversations.js';
import type { TaskRunService } from './service.js';
import {
  chatReceipt,
  readChatReceipt,
  readChatRun,
  type ChatAdmissionReceipt,
  type ReceiptQuery,
  type RunQuery,
} from './chat-receipts.js';
export type { ChatAdmissionReceipt, ReceiptQuery, RunQuery } from './chat-receipts.js';
export type {
  ChatAdmissionMode,
  DirectChatRequest,
  ChatProviderSource,
} from './direct-chat-admission.js';
import type { ChatMessage, ProviderPort } from './provider.js';
import type { TurnUpdate } from './turn-update.js';
export { ChatPreparationRefusal } from './chat-preparation.js';

export interface RecordedRoomMessage {
  readonly status: 'recorded';
  readonly roomId: string;
  readonly messageId: string;
  readonly taskRunId: null;
}
export interface DirectChatDeps extends ConversationServiceDeps {
  readonly tasks: TaskRunService;
  readonly sha256?: (text: string) => string;
  readonly reviews?: Pick<ChatReviewService, 'review'>;
  readonly codingTools?: {
    /** Successful preparation must join its workers and prove their cleanup before returning. */
    forTurn(turn: ChatTurn, signal: AbortSignal): Promise<ChatCodingTools>;
  };
  /** Task-independent granted plugin tools; absent means plugin-disabled behavior. */
  readonly grantedTools?: {
    forTurn(turn: ChatTurn, signal: AbortSignal): Promise<GrantedPluginTools | null>;
  };
}
export type SubmitDirectInput = DirectChatRequest &
  ChatProviderSource & {
    readonly signal: AbortSignal;
    readonly emit: (update: TurnUpdate) => void;
  };
export type SendDirectInput = SubmitDirectInput & {
  readonly onAdmitted?: (turn: ChatTurn) => void;
};
/** One host-neutral direct dialogue path for CLI and TUI, reconstructed from committed history. */
export class DirectChatService {
  readonly #deps: DirectChatDeps;
  constructor(deps: DirectChatDeps) {
    this.#deps = deps;
  }
  /** Commit admission synchronously. Only this fresh invocation starts private execution. */
  submit(
    input: SubmitDirectInput,
    mode: ChatAdmissionMode = 'admit',
  ): ConversationResult<{ receipt: ChatAdmissionReceipt; completion: Promise<ChatTurn> | null }> {
    const begun = this.#begin(input, mode);
    if (!begun.ok) return begun;
    const { receipt, completion } = begun.value;
    return ok({ receipt, completion });
  }
  /** Legacy callers await the fresh turn, or observe the current state on an exact retry. */
  async send(input: SendDirectInput): Promise<ConversationResult<ChatTurn | RecordedRoomMessage>> {
    const begun = this.#begin(input, 'admit', input.onAdmitted);
    if (!begun.ok) return begun;
    return ok(begun.value.completion ? await begun.value.completion : begun.value.observed);
  }
  getReceipt(query: ReceiptQuery) {
    return readChatReceipt(this.#deps.store, query);
  }
  getRun(query: RunQuery) {
    return readChatRun(this.#deps.store, this.#deps.tasks, query);
  }
  #begin(
    submitted: SubmitDirectInput,
    mode: ChatAdmissionMode,
    onAdmitted?: SendDirectInput['onAdmitted'],
  ): ConversationResult<{
    receipt: ChatAdmissionReceipt;
    completion: Promise<ChatTurn> | null;
    observed: ChatTurn | RecordedRoomMessage;
  }> {
    if ('resolver' in submitted === 'provider' in submitted)
      return conversationFailure('invalid_input');
    const input = { ...submitted };
    const admitted = admitChat(this.#deps, input, input, {
      mode,
      codingAvailable: this.#deps.codingTools !== undefined,
    });
    if (!admitted.ok) return admitted;
    if ('record' in admitted.value) {
      const { record } = admitted.value;
      return ok({
        receipt: chatReceipt(input.requestId, record),
        completion: null,
        observed: {
          status: 'recorded',
          roomId: record.roomId,
          messageId: record.id,
          taskRunId: null,
        },
      });
    }
    const admission = admitted.value;
    const { turn, fresh, messages } = admission;
    onAdmitted?.(structuredClone(turn));
    return ok({
      receipt: chatReceipt(input.requestId, turn),
      observed: turn,
      completion: fresh
        ? Promise.resolve().then(() => this.#execute(input, turn, messages, admission.provider))
        : null,
    });
  }
  async #execute(
    input: SubmitDirectInput,
    turn: ChatTurn,
    messages: readonly ChatMessage[],
    provider: ProviderPort,
  ): Promise<ChatTurn> {
    return executeChatTurn(
      {
        tasks: this.#deps.tasks,
        store: this.#deps.store,
        clock: this.#deps.clock,
        ...(this.#deps.reviews === undefined ? {} : { reviews: this.#deps.reviews }),
        ...(this.#deps.codingTools === undefined ? {} : { codingTools: this.#deps.codingTools }),
        ...(this.#deps.grantedTools === undefined ? {} : { grantedTools: this.#deps.grantedTools }),
      },
      {
        turn,
        messages,
        provider,
        signal: input.signal,
        emit: input.emit,
      },
    );
  }
  /** Requires exclusive host ownership. Never replays a provider or tool request. */
  recover(): Promise<void> {
    return recoverChats(
      this.#deps.store,
      this.#deps.tasks,
      this.#deps.clock,
      this.#deps.reviews,
      this.#deps.sha256,
    );
  }
}
