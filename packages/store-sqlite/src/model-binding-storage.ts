import type { DatabaseSync } from 'node:sqlite';
import type { Bot, BotModelBinding } from '@runnets/domain';
import { unconfiguredModelConnection } from '@runnets/application';
import { readModelConnection, writeModelConnection } from './model-connection-storage.js';

export function modelBindingStorage(db: DatabaseSync) {
  return {
    replaceBot(bot: Bot, expectedProfileVersion: number): void {
      if (
        !Number.isSafeInteger(expectedProfileVersion) ||
        expectedProfileVersion < 1 ||
        !Number.isSafeInteger(bot.profileVersion) ||
        bot.profileVersion !== expectedProfileVersion + 1
      )
        throw Error('bot_profile_version_conflict');
      const changed = db
        .prepare(
          `UPDATE ocean_bots SET handle=?,name=?,role=?,provider=?,model=?,profile_version=?
        WHERE id=? AND workspace_id=? AND profile_version=?`,
        )
        .run(
          bot.handle,
          bot.name,
          bot.role,
          bot.provider,
          bot.model,
          bot.profileVersion,
          bot.id,
          bot.workspaceId,
          expectedProfileVersion,
        );
      if (changed.changes !== 1) throw Error('bot_profile_version_conflict');
    },
    modelBinding(botId: string): BotModelBinding | null {
      const row = db
        .prepare('SELECT connection_id,model_id FROM ocean_bot_model_bindings WHERE bot_id=?')
        .get(botId);
      if (!row) return null;
      if (typeof row['connection_id'] !== 'string' || typeof row['model_id'] !== 'string')
        throw Error('binding_unverified');
      return { connectionId: row['connection_id'], modelId: row['model_id'] };
    },
    putModelBinding(botId: string, binding: BotModelBinding): void {
      if (
        !binding.connectionId ||
        !binding.modelId ||
        binding.connectionId.includes('\0') ||
        binding.modelId.includes('\0')
      )
        throw Error('invalid_model_binding');
      db.prepare(
        `INSERT INTO ocean_bot_model_bindings VALUES(?,?,?) ON CONFLICT(bot_id)
        DO UPDATE SET connection_id=excluded.connection_id,model_id=excluded.model_id`,
      ).run(botId, binding.connectionId, binding.modelId);
    },
  };
}
/** Invoked synchronously under the conversation transaction, never through a nested store CAS. */
export function insertLegacyModelBinding(db: DatabaseSync, bot: Bot): void {
  const placeholder = unconfiguredModelConnection(bot.provider);
  if (readModelConnection(db, placeholder.connectionId) === null)
    writeModelConnection(db, placeholder, null);
  modelBindingStorage(db).putModelBinding(bot.id, {
    connectionId: placeholder.connectionId,
    modelId: bot.model,
  });
}
