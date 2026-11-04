import { legacyReviewKey } from './owner-decisions.js';
import type {
  ConversationReceipt,
  ConversationStore,
  ConversationTransaction,
} from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { reviewStorage } from './review-storage.js';
import { chatStorage } from './chat-storage.js';
import { broadcastStorage } from './broadcast-storage.js';

import { withImmediateTransaction } from './transaction.js';
import { botRow, messageRow, roomRow, workspaceRow } from './conversation-rows.js';
import { readText } from './rows.js';
import { SCHEMA_VERSION } from './schema.js';
import { insertLegacyModelBinding, modelBindingStorage } from './model-binding-storage.js';

/** SQLite writes and request receipts commit under one immediate write lock. */
export class SqliteConversationStore implements ConversationStore {
  readonly #db: DatabaseSync;
  readonly #legacyKey: (id: string) => ConversationReceipt | null;
  readonly #legacySchema: boolean;
  constructor(db: DatabaseSync, options: { readonly legacySchema?: true } = {}) {
    this.#db = db;
    this.#legacyKey = legacyReviewKey(db);
    this.#legacySchema = options.legacySchema === true;
  }
  /** Pre-migration fixtures stay readable; the broadcast surface is current-schema only. */
  #broadcastSurface() {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    const version = Number(row?.['value']);
    return Number.isSafeInteger(version) && version < 16 ? null : broadcastStorage(this.#db);
  }

  /** Roll back profile, room, history and sequence allocation if any receipt write fails. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T {
    const db = this.#db,
      legacyKey = this.#legacyKey;
    const version = Number(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    );
    const current = version === SCHEMA_VERSION;
    if (
      !current &&
      !(
        this.#legacySchema &&
        Number.isSafeInteger(version) &&
        version >= 1 &&
        version < SCHEMA_VERSION
      )
    )
      throw Error('unsupported_schema');
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
        ...(current
          ? modelBindingStorage(db)
          : {
              modelBinding: () => null,
              putModelBinding: () => {
                throw Error('unsupported_schema');
              },
            }),
        ...(() => {
          const broadcasts = this.#broadcastSurface();
          if (broadcasts === null)
            return {
              broadcastBatch: () => null,
              broadcastBatchByRequest: () => null,
              broadcastBatchForRoom: () => null,
              broadcastBatches: () => [],
              broadcastOpenBatches: () => [],
              putBroadcastBatch: () => {
                throw Error('unsupported_schema');
              },
              broadcastTurns: () => [],
            };
          return {
            broadcastBatch: (id) => broadcasts.batch(id),
            broadcastBatchByRequest: (id) => broadcasts.batchByRequest(id),
            broadcastBatchForRoom: (id) => broadcasts.batchForRoom(id),
            broadcastBatches: (id, limit) => broadcasts.batches(id, limit),
            broadcastOpenBatches: () => broadcasts.openBatches(),
            putBroadcastBatch: (batch) => broadcasts.putBatch(batch),
            broadcastTurns: (id) => broadcasts.turns(id),
          };
        })(),
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
          if (current) insertLegacyModelBinding(db, b);
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
          if (row === undefined) return legacyKey(id);
          const reply: unknown = JSON.parse(readText(row, 'reply'));
          if (
            reply === null ||
            typeof reply !== 'object' ||
            !('kind' in reply) ||
            !['workspace', 'bot', 'room', 'message', 'turn', 'review', 'review_request'].includes(
              String(reply.kind),
            ) ||
            !('data' in reply)
          )
            throw new Error('Invalid conversation receipt');
          return { binding: readText(row, 'binding'), reply } as ConversationReceipt;
        },
        completeReviewRequest(id, decisionId, binding, review) {
          const changed = db
            .prepare(
              `UPDATE ocean_receipts SET reply=? WHERE request_id=? AND binding=?
            AND json_extract(reply,'$.kind')='review_request' AND json_extract(reply,'$.data.id')=?
            AND json_extract(reply,'$.data.workspaceId')=? AND json_extract(reply,'$.data.roomId')=?
            AND json_extract(reply,'$.data.taskRunId')=?`,
            )
            .run(
              JSON.stringify({ kind: 'review', data: review }),
              id,
              binding,
              decisionId,
              review.workspaceId,
              review.roomId,
              review.taskRunId,
            );
          if (changed.changes !== 1) throw Error('request_conflict');
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
