import {
  isBotInput,
  isDirectInput,
  isGroupInput,
  isLocalRoomsQuery,
  isPendingQuery,
} from '@runnets/contracts';
import type { ConversationCommand, ConversationService } from '@runnets/application';
import type { ProfileReads } from '@runnets/store-sqlite';
import { wirePage, type RuntimeReply } from './queries.js';
export function profileCommand(
  conversations: ConversationService,
  reads: ProfileReads,
  method: string,
  p: Record<string, unknown>,
  draining: boolean,
): RuntimeReply {
  if (p['workspaceId'] !== 'ws_ocean') return { error: { code: 'unknown_workspace' } };
  if (method === 'bots.list' && isLocalRoomsQuery(p))
    return { result: wirePage(reads.bots(p.workspaceId, p.after ?? '', p.limit ?? 50)) };
  if (method === 'coding.pending' && isPendingQuery(p)) {
    const held = reads.pending(p.workspaceId, p.roomId ?? null, p.after ?? '', p.limit ?? 50);
    return {
      result: {
        workspaceId: p.workspaceId,
        roomId: p.roomId ?? null,
        applications: wirePage(held.applications),
        omittedPendingEffects: held.omittedPendingEffects,
      },
    };
  }
  const command: ConversationCommand | null =
    method === 'bots.create' && isBotInput(p)
      ? { ...p, type: 'CreateBot' }
      : method === 'rooms.direct' && isDirectInput(p)
        ? { ...p, type: 'OpenDirectRoom' }
        : method === 'rooms.group' && isGroupInput(p)
          ? { ...p, type: 'CreateGroupRoom' }
          : null;
  if (!command) return { error: { code: 'invalid_params' } };
  const result = conversations.execute(command, draining ? 'existing_only' : 'admit');
  return result.ok
    ? { result: result.value }
    : {
        error: {
          code: result.error.code === 'admission_closed' ? 'runtime_draining' : result.error.code,
        },
      };
}
