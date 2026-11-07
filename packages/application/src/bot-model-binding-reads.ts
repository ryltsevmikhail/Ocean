import type { Bot, BotModelBinding } from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import { boundedModelText } from './model-connection-input.js';
import { modelReadPage, boundedModelPage, type ModelReadPageInput } from './model-read-pages.js';
export interface ListBoundBotsInput extends ModelReadPageInput {
  readonly workspaceId: string;
  readonly roomId?: string;
}
export interface BoundBotMetadata {
  readonly bot: Bot;
  readonly binding: BotModelBinding | null;
}
export interface BoundBotPage {
  readonly version: 1;
  readonly workspaceId: string;
  readonly roomId: string | null;
  readonly items: readonly BoundBotMetadata[];
  readonly nextAfter: string | null;
}
/** Profiles and bindings are copied in the same canonical transaction, including missing bindings. */
export class BotModelBindingReads {
  readonly store: ConversationStore;
  constructor(store: ConversationStore) {
    this.store = store;
  }
  list(input: ListBoundBotsInput): BoundBotPage {
    const settings = modelReadPage(input, 128);
    const workspaceId = boundedModelText(input.workspaceId, 128);
    const roomId = input.roomId === undefined ? null : boundedModelText(input.roomId, 128);
    return this.store.atomic((tx) => {
      if (tx.workspace()?.id !== workspaceId) throw Error('workspace_conflict');
      const room = roomId === null ? null : tx.room(roomId);
      if (roomId !== null && room === null) throw Error('unknown_room');
      if (room !== null && room.workspaceId !== workspaceId) throw Error('workspace_conflict');
      const members = room === null ? null : room.kind === 'direct' ? [room.botId] : room.botIds;
      const rows = tx
        .bots()
        .filter(
          (b) => b.workspaceId === workspaceId && (members === null || members.includes(b.id)),
        );
      const scope = { version: 1 as const, workspaceId, roomId };
      return {
        ...scope,
        ...boundedModelPage(
          rows,
          settings,
          (b) => b.id,
          (b): BoundBotMetadata => {
            const binding = tx.modelBinding(b.id);
            return {
              bot: {
                id: b.id,
                workspaceId: b.workspaceId,
                handle: b.handle,
                name: b.name,
                role: b.role,
                provider: b.provider,
                model: b.model,
                profileVersion: b.profileVersion,
              },
              binding:
                binding === null
                  ? null
                  : {
                      connectionId: boundedModelText(binding.connectionId, 256),
                      modelId: boundedModelText(binding.modelId, 256),
                    },
            };
          },
          scope,
        ),
      };
    });
  }
}
