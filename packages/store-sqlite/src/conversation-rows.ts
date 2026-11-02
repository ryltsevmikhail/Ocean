import type { Bot, ConversationMessage, Room, Workspace } from '@runnets/domain';
import { readText } from './rows.js';

type Row = Record<string, unknown>;
function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid conversation integer');
  return value;
}
/** Decode persisted workspace metadata without exposing database row objects. */
export function workspaceRow(row: Row): Workspace {
  return { id: readText(row, 'id'), root: readText(row, 'root') };
}
/** Decode a complete stable bot profile. */
export function botRow(row: Row): Bot {
  return {
    id: readText(row, 'id'),
    workspaceId: readText(row, 'workspace_id'),
    handle: readText(row, 'handle'),
    name: readText(row, 'name'),
    role: readText(row, 'role'),
    provider: readText(row, 'provider'),
    model: readText(row, 'model'),
    profileVersion: integer(row, 'profile_version'),
  };
}
/** Only M1 direct rooms are accepted by this adapter version. */
export function roomRow(row: Row, botIds: readonly string[] = []): Room {
  if (row['kind'] === 'group')
    return {
      id: readText(row, 'id'),
      workspaceId: readText(row, 'workspace_id'),
      kind: 'group',
      title: readText(row, 'title'),
      botIds,
    };
  if (row['kind'] !== 'direct') throw new Error('Unsupported room kind');
  return {
    id: readText(row, 'id'),
    workspaceId: readText(row, 'workspace_id'),
    kind: 'direct',
    botId: readText(row, 'bot_id'),
  };
}
/** M1 stores user-authored records, never invented assistant completions. */
export function messageRow(row: Row): ConversationMessage {
  if (row['author'] !== 'user' && row['author'] !== 'bot')
    throw new Error('Unsupported message author');
  return {
    id: readText(row, 'id'),
    workspaceId: readText(row, 'workspace_id'),
    roomId: readText(row, 'room_id'),
    seq: integer(row, 'seq'),
    author: row['author'],
    ...(row['author'] === 'bot'
      ? { authorBotId: readText(row, 'author_bot_id'), turnId: readText(row, 'turn_id') }
      : {}),
    targetBotId: row['target_bot_id'] === null ? null : readText(row, 'target_bot_id'),
    body: readText(row, 'body'),
    createdAt: readText(row, 'created_at'),
  };
}
