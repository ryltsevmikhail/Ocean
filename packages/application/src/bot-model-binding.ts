import { admitBotModelBinding } from './room-model-policy.js';
import {
  conversationFailure,
  ok,
  validConversationText,
  validateBotProfile,
  type BotModelBinding,
  type BoundBot,
  type ConversationResult,
} from '@runnets/domain';
import type { ConversationStore, ConversationTransaction } from './conversation-ports.js';
import type { ModelConnectionStorePort } from './model-connection-ports.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';

interface BindingRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly binding: BotModelBinding;
}
export interface CreateBoundBotInput extends BindingRequest {
  readonly handle: string;
  readonly name: string;
  readonly role: string;
}
export interface SetBotModelBindingInput extends BindingRequest {
  readonly botId: string;
  readonly expectedProfileVersion: number;
}
export interface BotModelBindingServiceDeps {
  readonly store: ConversationStore;
  /** Metadata reads must share the conversation transaction's synchronous snapshot. */
  readonly connections: Pick<ModelConnectionStorePort, 'read'>;
  readonly factory: Pick<ModelCredentialFactory, 'catalog'>;
  readonly nextId: () => string;
}
function detachBinding(binding: BotModelBinding): BotModelBinding | null {
  if (
    binding === null ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    !validConversationText(binding.connectionId, 256) ||
    !validConversationText(binding.modelId, 256)
  )
    return null;
  return { connectionId: binding.connectionId, modelId: binding.modelId };
}

/** Profile edits persist projection, binding and receipt together without activating credentials. */
export class BotModelBindingService {
  readonly #deps: BotModelBindingServiceDeps;
  constructor(deps: BotModelBindingServiceDeps) {
    this.#deps = deps;
  }
  create(input: CreateBoundBotInput): ConversationResult<BoundBot> {
    const binding = detachBinding(input.binding);
    if (
      binding === null ||
      typeof input.handle !== 'string' ||
      !validConversationText(input.name, 256) ||
      !validConversationText(input.role, 8192)
    )
      return conversationFailure('invalid_input');
    const request = {
      type: 'CreateBoundBot',
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      handle: input.handle,
      name: input.name,
      role: input.role,
      binding,
    } as const;
    return this.#execute(request, (tx) => {
      const provider = this.#provider(binding);
      if (!provider.ok) return provider;
      const profile = validateBotProfile({
        ...request,
        provider: provider.value,
        model: binding.modelId,
      });
      if (!profile.ok) return profile;
      if (tx.botByHandle(request.handle) !== null) return conversationFailure('handle_taken');
      const bot = {
        ...profile.value,
        id: this.#deps.nextId(),
        workspaceId: request.workspaceId,
        profileVersion: 1,
      };
      tx.putBot(bot);
      tx.putModelBinding(bot.id, binding);
      return ok({ bot, binding });
    });
  }
  set(input: SetBotModelBindingInput): ConversationResult<BoundBot> {
    const binding = detachBinding(input.binding);
    if (
      binding === null ||
      !validConversationText(input.botId, 128) ||
      !Number.isSafeInteger(input.expectedProfileVersion) ||
      input.expectedProfileVersion < 1 ||
      input.expectedProfileVersion >= Number.MAX_SAFE_INTEGER
    )
      return conversationFailure('invalid_input');
    const request = {
      type: 'SetBotModelBinding',
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      botId: input.botId,
      expectedProfileVersion: input.expectedProfileVersion,
      binding,
    } as const;
    return this.#execute(request, (tx) => {
      const previous = tx.bot(request.botId);
      if (previous === null) return conversationFailure('unknown_bot');
      if (previous.workspaceId !== request.workspaceId)
        return conversationFailure('workspace_conflict');
      if (previous.profileVersion !== request.expectedProfileVersion)
        return conversationFailure('bot_profile_version_conflict');
      const provider = this.#provider(binding);
      if (!provider.ok) return provider;
      const admission = admitBotModelBinding(tx, previous.id, binding, this.#deps.connections);
      if (!admission.ok) return admission;
      const bot = {
        ...previous,
        provider: provider.value,
        model: binding.modelId,
        profileVersion: previous.profileVersion + 1,
      };
      tx.replaceBot(bot, request.expectedProfileVersion);
      tx.putModelBinding(bot.id, binding);
      return ok({ bot, binding });
    });
  }
  #provider(binding: BotModelBinding): ConversationResult<string> {
    const connection = this.#deps.connections.read(binding.connectionId);
    if (connection === null) return conversationFailure('unknown_connection');
    if (!this.#deps.factory.catalog(connection).some((entry) => entry.modelId === binding.modelId))
      return conversationFailure('unknown_model');
    return ok(connection.providerId);
  }
  #execute(
    request: BindingRequest & { readonly type: string },
    work: (tx: ConversationTransaction) => ConversationResult<BoundBot>,
  ): ConversationResult<BoundBot> {
    if (
      !validConversationText(request.workspaceId, 128) ||
      !validConversationText(request.requestId, 128)
    )
      return conversationFailure('invalid_input');
    const fingerprint = JSON.stringify(request);
    return this.#deps.store.atomic((tx) => {
      const previous = tx.receipt(request.requestId);
      if (previous !== null)
        return previous.binding === fingerprint && previous.reply.kind === 'bound_bot'
          ? ok(previous.reply.data)
          : conversationFailure('request_conflict');
      if (tx.workspace()?.id !== request.workspaceId)
        return conversationFailure('workspace_conflict');
      const result = work(tx);
      if (result.ok)
        tx.putReceipt(request.requestId, {
          binding: fingerprint,
          reply: { kind: 'bound_bot', data: result.value },
        });
      return result;
    });
  }
}
