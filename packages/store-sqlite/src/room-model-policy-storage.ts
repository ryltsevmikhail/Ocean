import { validRoomModelPolicy } from '@runnets/domain';
import type { ConversationTransaction } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
/** The surrounding conversation transaction owns policy and receipt publication. */
export function roomModelPolicyStorage(
  db: DatabaseSync,
): Pick<ConversationTransaction, 'roomModelPolicy' | 'putRoomModelPolicy'> {
  return {
    roomModelPolicy(roomId) {
      const row = db.prepare('SELECT * FROM ocean_room_model_policies WHERE room_id=?').get(roomId);
      if (row === undefined) return null;
      const policy = {
        roomId: row['room_id'],
        cloudTransfer: row['cloud_transfer'],
        revision: row['revision'],
      };
      // Invalid authority is unavailable, never permission and never coerced from a scalar-like value.
      return validRoomModelPolicy(policy) ? { ...policy } : null;
    },
    putRoomModelPolicy(policy) {
      if (!validRoomModelPolicy(policy)) throw Error('model_policy_unavailable');
      db.prepare(
        `INSERT INTO ocean_room_model_policies VALUES(?,?,?) ON CONFLICT(room_id)
        DO UPDATE SET cloud_transfer=excluded.cloud_transfer,revision=excluded.revision`,
      ).run(policy.roomId, policy.cloudTransfer, policy.revision);
    },
  };
}
