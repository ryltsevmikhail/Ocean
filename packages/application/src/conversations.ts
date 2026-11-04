import {
  conversationFailure,
  ok,
  validConversationText,
  validateBotProfile,
  type Bot,
  type ConversationMessage,
  type ConversationResult,
  type Room,
} from '@runnets/domain';
import type { ImageAssetResolverPort } from './image-content.js';
import type { Clock } from './ports.js';
import type {
  ConversationCommand,
  ConversationReply,
  ConversationStore,
  ConversationTransaction,
} from './conversation-ports.js';

export interface ConversationServiceDeps {
  readonly store: ConversationStore;
  readonly nextId: () => string;
  readonly clock: Clock;
  /**
   * Runtime-owned image authority. Every durable profile host composes it (the
   * shared runtime; the TUI never opens a durable profile on its own); only
   * ephemeral/no-asset hosts omit it. An attachment marker (image or text) is then
   * refused explicitly, never silently dropped.
   *
   * The offline CLI host resolves images through the same port but does not
   * replicate the runtime's pre-write prepared-`to` refusal; it keeps the same
   * room/hash/bytes checks in admission and refuses the turn instead.
   */
  readonly images?: ImageAssetResolverPort | undefined;
}

/** Own workspace, profile and direct-history rules under one atomic adapter transaction. */
export class ConversationService {
  readonly #deps: ConversationServiceDeps;
  constructor(deps: ConversationServiceDeps) {
    this.#deps = deps;
  }

  /** Bind a complete immutable request to its receipt before returning success. */
  execute(
    command: ConversationCommand,
    admission: 'admit' | 'existing_only' = 'admit',
  ): ConversationResult<ConversationReply> {
    // Detach the only nested input before any adapter or identity callback can observe it.
    if (command.type === 'CreateGroupRoom') command = { ...command, botIds: [...command.botIds] };
    const binding = JSON.stringify(
      Object.entries(command).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    if (
      !validConversationText(command.requestId, 128) ||
      !validConversationText(command.workspaceId, 128)
    )
      return conversationFailure('invalid_input');
    return this.#deps.store.atomic((tx) => {
      const previous = tx.receipt(command.requestId);
      if (previous !== null)
        return previous.binding === binding &&
          previous.reply.kind !== 'review_request' &&
          previous.reply.kind !== 'bound_bot' &&
          previous.reply.kind !== 'room_model_policy'
          ? ok(previous.reply)
          : conversationFailure('request_conflict');
      if (admission === 'existing_only') return conversationFailure('admission_closed');
      const result = this.#decide(tx, command);
      if (result.ok) tx.putReceipt(command.requestId, { binding, reply: result.value });
      return result;
    });
  }

  /** Only the bound workspace can enumerate its profiles. */
  bots(workspaceId: string): ConversationResult<readonly Bot[]> {
    return this.#deps.store.atomic((tx) =>
      tx.workspace()?.id === workspaceId
        ? ok(tx.bots())
        : conversationFailure('workspace_conflict'),
    );
  }

  /** Resolve a room only within the bound workspace. */
  room(workspaceId: string, roomId: string): ConversationResult<Room> {
    return this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== workspaceId) return conversationFailure('workspace_conflict');
      const room = tx.room(roomId);
      return room === null ? conversationFailure('unknown_room') : ok(room);
    });
  }

  /** Enumerate the bound workspace's rooms and their explicitly selected members. */
  rooms(workspaceId: string): ConversationResult<readonly Room[]> {
    return this.#deps.store.atomic((tx) =>
      tx.workspace()?.id === workspaceId
        ? ok(tx.rooms())
        : conversationFailure('workspace_conflict'),
    );
  }
  /** Resolve membership only after checking room scope. */
  members(workspaceId: string, roomId: string): ConversationResult<readonly Bot[]> {
    const room = this.room(workspaceId, roomId);
    if (!room.ok) return room;
    return this.#deps.store.atomic((tx) => {
      const ids = room.value.kind === 'direct' ? [room.value.botId] : room.value.botIds;
      return ok(
        ids.map((id) => {
          const b = tx.bot(id);
          if (b === null) throw new Error('Missing room member');
          return b;
        }),
      );
    });
  }
  /** Return an ordered, room-scoped page without loading another room's history. */
  history(
    workspaceId: string,
    roomId: string,
    after = 0,
    limit = 50,
  ): ConversationResult<readonly ConversationMessage[]> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      return conversationFailure('invalid_input');
    return this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== workspaceId) return conversationFailure('workspace_conflict');
      if (tx.room(roomId) === null) return conversationFailure('unknown_room');
      return ok(tx.history(roomId, after, limit));
    });
  }

  #decide(
    tx: ConversationTransaction,
    command: ConversationCommand,
  ): ConversationResult<ConversationReply> {
    const workspace = tx.workspace();
    if (command.type === 'BindWorkspace') {
      if (
        !validConversationText(command.root, 4096) ||
        !command.root.startsWith('/') ||
        command.root.split('/').some((p) => p === '.' || p === '..')
      )
        return conversationFailure('invalid_input');
      if (workspace !== null)
        return workspace.id === command.workspaceId && workspace.root === command.root
          ? ok({ kind: 'workspace', data: workspace })
          : conversationFailure('workspace_conflict');
      const data = { id: command.workspaceId, root: command.root };
      tx.putWorkspace(data);
      return ok({ kind: 'workspace', data });
    }
    if (workspace?.id !== command.workspaceId) return conversationFailure('workspace_conflict');
    switch (command.type) {
      case 'CreateBot': {
        const profile = validateBotProfile(command);
        if (!profile.ok) return profile;
        if (tx.botByHandle(command.handle) !== null) return conversationFailure('handle_taken');
        const data: Bot = {
          ...profile.value,
          id: this.#deps.nextId(),
          workspaceId: workspace.id,
          profileVersion: 1,
        };
        tx.putBot(data);
        return ok({ kind: 'bot', data });
      }
      case 'OpenDirectRoom': {
        const bot = tx.bot(command.botId);
        if (bot === null) return conversationFailure('unknown_bot');
        const existing = tx.directRoom(bot.id);
        if (existing !== null) return ok({ kind: 'room', data: existing });
        const data = {
          id: this.#deps.nextId(),
          workspaceId: workspace.id,
          kind: 'direct' as const,
          botId: bot.id,
        };
        tx.putRoom(data);
        return ok({ kind: 'room', data });
      }
      case 'CreateGroupRoom': {
        if (
          !validConversationText(command.title, 256) ||
          command.botIds.length < 2 ||
          command.botIds.length > 32 ||
          new Set(command.botIds).size !== command.botIds.length
        )
          return conversationFailure('invalid_input');
        for (const id of command.botIds)
          if (tx.bot(id) === null) return conversationFailure('unknown_bot');
        const data = {
          id: this.#deps.nextId(),
          workspaceId: workspace.id,
          kind: 'group' as const,
          title: command.title,
          botIds: [...command.botIds].sort(),
        };
        tx.putRoom(data);
        return ok({ kind: 'room', data });
      }
      case 'RecordUserMessage': {
        if (tx.activeChatTurn(command.roomId) !== null) return conversationFailure('room_busy');
        if (!validConversationText(command.text, 16384))
          return conversationFailure('invalid_input');
        const room = tx.room(command.roomId);
        if (room === null) return conversationFailure('unknown_room');
        const data: ConversationMessage = {
          id: this.#deps.nextId(),
          workspaceId: workspace.id,
          roomId: room.id,
          seq: tx.nextSequence(room.id),
          author: 'user',
          targetBotId: room.kind === 'direct' ? room.botId : null,
          body: command.text,
          createdAt: this.#deps.clock.now().toISOString(),
        };
        tx.putMessage(data);
        return ok({ kind: 'message', data });
      }
    }
  }
}
