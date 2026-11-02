import type {
  ConversationReceipt,
  ConversationStore,
  ConversationTransaction,
} from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { reviewStorage } from './review-storage.js';
import { chatStorage } from './chat-storage.js';

import { withImmediateTransaction } from './transaction.js';
import { botRow, messageRow, roomRow, workspaceRow } from './conversation-rows.js';
import { readText } from './rows.js';

/** SQLite writes and request receipts commit under one immediate write lock. */
export class SqliteConversationStore implements ConversationStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Roll back profile, room, history and sequence allocation if any receipt write fails. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T {
    const db = this.#db;
    const decodeRoom = (row: Record<string, unknown>) =>
      roomRow(
        row,
        db
          .prepare('SELECT bot_id FROM ocean_members WHERE room_id=? ORDER BY bot_id')
          .all(readText(row, 'id'))
          .map((m) => readText(m, 'bot_id')),
      );

    return withImmediateTransaction(db, () =>
      work({
        ...chatStorage(db),
        ...reviewStorage(db),
        workspace() {
          const row = db.prepare('SELECT * FROM ocean_workspace WHERE singleton=1').get();
          return row === undefined ? null : workspaceRow(row);
        },
        putWorkspace(w) {
          db.prepare('INSERT INTO ocean_workspace VALUES(1,?,?)').run(w.id, w.root);
        },
        bot(id) {
          const row = db.prepare('SELECT * FROM ocean_bots WHERE id=?').get(id);
          return row === undefined ? null : botRow(row);
        },
        botByHandle(handle) {
          const row = db.prepare('SELECT * FROM ocean_bots WHERE handle=?').get(handle);
          return row === undefined ? null : botRow(row);
        },
        bots: () => db.prepare('SELECT * FROM ocean_bots ORDER BY handle').all().map(botRow),
        putBot(b) {
          db.prepare('INSERT INTO ocean_bots VALUES(?,?,?,?,?,?,?,?)').run(
            b.id,
            b.workspaceId,
            b.handle,
            b.name,
            b.role,
            b.provider,
            b.model,
            b.profileVersion,
          );
        },
        room(id) {
          const row = db.prepare('SELECT * FROM ocean_rooms WHERE id=?').get(id);
          return row === undefined ? null : decodeRoom(row);
        },
        rooms: () => db.prepare('SELECT * FROM ocean_rooms ORDER BY id').all().map(decodeRoom),
        directRoom(botId) {
          const row = db.prepare('SELECT * FROM ocean_rooms WHERE bot_id=?').get(botId);
          if (row === undefined) return null;
          const room = decodeRoom(row);
          if (room.kind !== 'direct') throw new Error('Expected direct room');
          return room;
        },
        putRoom(r) {
          db.prepare('INSERT INTO ocean_rooms VALUES(?,?,?,?,?)').run(
            r.id,
            r.workspaceId,
            r.kind,
            r.kind === 'direct' ? r.botId : null,
            r.kind === 'group' ? r.title : null,
          );
          for (const id of r.kind === 'direct' ? [r.botId] : r.botIds)
            db.prepare('INSERT INTO ocean_members VALUES(?,?,?)').run(r.workspaceId, r.id, id);
        },
        history: (roomId, after, limit) =>
          db
            .prepare('SELECT * FROM ocean_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?')
            .all(roomId, after, limit)
            .map(messageRow),
        nextSequence(roomId) {
          const row = db
            .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM ocean_messages WHERE room_id=?')
            .get(roomId);
          const seq = row?.['seq'];
          if (typeof seq !== 'number' || !Number.isSafeInteger(seq))
            throw new Error('Invalid sequence');
          return seq;
        },
        putMessage(m) {
          db.prepare('INSERT INTO ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            m.id,
            m.workspaceId,
            m.roomId,
            m.seq,
            m.author,
            m.targetBotId,
            m.body,
            m.createdAt,
            m.authorBotId ?? null,
            m.turnId ?? null,
          );
        },
        receipt(id) {
          const row = db.prepare('SELECT * FROM ocean_receipts WHERE request_id=?').get(id);
          if (row === undefined) return null;
          const reply: unknown = JSON.parse(readText(row, 'reply'));
          if (
            reply === null ||
            typeof reply !== 'object' ||
            !('kind' in reply) ||
            !['workspace', 'bot', 'room', 'message', 'turn', 'review'].includes(
              String(reply.kind),
            ) ||
            !('data' in reply)
          )
            throw new Error('Invalid conversation receipt');
          return { binding: readText(row, 'binding'), reply } as ConversationReceipt;
        },
        putReceipt(id, r) {
          db.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)').run(
            id,
            r.binding,
            JSON.stringify(r.reply),
          );
        },
      }),
    );
  }
}
