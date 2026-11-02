import type { DatabaseSync } from 'node:sqlite';
import type { CodingStore, CodingTransaction } from '@runnets/application';
import type { CodingTask } from '@runnets/domain';
import { withImmediateTransaction } from './transaction.js';
function task(row: Record<string, unknown> | undefined): CodingTask | null {
  if (!row) return null;
  const t = JSON.parse(String(row['payload'])) as CodingTask;
  if (
    t.id !== row['id'] ||
    t.workspaceId !== row['workspace_id'] ||
    t.projectRoot !== row['project_root'] ||
    t.ownerRoomId !== row['owner_room_id'] ||
    t.devBotId !== row['dev_bot_id'] ||
    t.reviewRoomId !== row['review_room_id'] ||
    t.reviewBotId !== row['review_bot_id'] ||
    t.status !== row['status'] ||
    t.policyVersion !== row['policy_version']
  )
    throw Error('Invalid coding task');
  return t;
}
export class SqliteCodingStore implements CodingStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  atomic<T>(work: (tx: CodingTransaction) => T): T {
    const db = this.#db;
    return withImmediateTransaction(db, () =>
      work({
        task: (id) => task(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
        putTask: (t) => {
          const old = task(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(t.id));
          if (
            old &&
            (JSON.stringify({ ...old, status: t.status }) !== JSON.stringify(t) ||
              (old.status === 'cancelled' && t.status !== 'cancelled'))
          )
            throw Error('Immutable coding binding');
          db.prepare(
            `INSERT INTO ocean_coding_tasks VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload`,
          ).run(
            t.id,
            t.workspaceId,
            t.projectRoot,
            t.ownerRoomId,
            t.devBotId,
            t.reviewRoomId,
            t.reviewBotId,
            t.status,
            t.policyVersion,
            JSON.stringify(t),
          );
        },
        receipt: (id) => {
          const row = db.prepare('SELECT * FROM ocean_coding_receipts WHERE request_id=?').get(id);
          return row ? { binding: String(row['binding']), taskId: String(row['task_id']) } : null;
        },
        putReceipt: (id, r) => {
          db.prepare('INSERT INTO ocean_coding_receipts VALUES(?,?,?)').run(
            id,
            r.binding,
            r.taskId,
          );
        },
        workspaceRoot: (id) => {
          const row = db.prepare('SELECT root FROM ocean_workspace WHERE id=?').get(id);
          return row ? String(row['root']) : null;
        },
        participates: (ws, room, bot) =>
          db
            .prepare(
              `SELECT 1 FROM ocean_members m
    JOIN ocean_rooms r ON r.id=m.room_id JOIN ocean_bots b ON b.id=m.bot_id
    WHERE m.workspace_id=? AND m.room_id=? AND m.bot_id=? AND r.workspace_id=? AND b.workspace_id=?`,
            )
            .get(ws, room, bot, ws, ws) !== undefined,
      }),
    );
  }
}
