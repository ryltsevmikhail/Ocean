import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CodingArtifactTransaction } from '@runnets/application';
import type { Changeset, CodingWorktree } from '@runnets/domain';
export function changesetStorage(db: DatabaseSync): CodingArtifactTransaction {
  return {
    worktree: (id) => {
      const row = db.prepare('SELECT * FROM ocean_worktrees WHERE task_id=?').get(id);
      if (!row) return null;
      const value = JSON.parse(String(row['payload'])) as CodingWorktree;
      if (
        value.taskId !== row['task_id'] ||
        value.root !== row['root'] ||
        value.state !== row['state']
      )
        throw Error('Invalid worktree');
      return value;
    },
    putWorktree: (value) => {
      const row = db
        .prepare('SELECT payload FROM ocean_worktrees WHERE task_id=?')
        .get(value.taskId);
      if (row) {
        const old = JSON.parse(String(row['payload'])) as CodingWorktree;
        if (
          JSON.stringify({ ...old, state: value.state }) !== JSON.stringify(value) ||
          (old.state !== 'preparing' && old.state !== value.state)
        )
          throw Error('Immutable worktree');
      }
      db.prepare(
        `INSERT INTO ocean_worktrees VALUES(?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,payload=excluded.payload`,
      ).run(value.taskId, value.root, value.state, JSON.stringify(value));
    },
    latestChangeset: (taskId) => {
      const row = db
        .prepare('SELECT hash FROM ocean_changesets WHERE task_id=? ORDER BY rowid DESC LIMIT 1')
        .get(taskId);
      return row ? changesetStorage(db).changeset(String(row['hash'])) : null;
    },
    changeset: (hash, taskId) => {
      const row =
        taskId === undefined
          ? db.prepare('SELECT * FROM ocean_changesets WHERE hash=?').get(hash)
          : db
              .prepare('SELECT * FROM ocean_changesets WHERE hash=? AND task_id=?')
              .get(hash, taskId);
      if (!row) return null;
      const value = JSON.parse(String(row['payload'])) as Changeset;
      const { id, hash: stored, ...payload } = value;
      if (
        id !== hash ||
        stored !== hash ||
        value.taskId !== row['task_id'] ||
        createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== hash
      )
        throw Error('Invalid changeset');
      return value;
    },
    putChangeset: (value) => {
      const payload = JSON.stringify(value);
      const old = db.prepare('SELECT payload FROM ocean_changesets WHERE hash=?').get(value.hash);
      if (old && old['payload'] !== payload) throw Error('Immutable changeset');
      if (!old)
        db.prepare('INSERT INTO ocean_changesets VALUES(?,?,?)').run(
          value.hash,
          value.taskId,
          payload,
        );
    },
    captureReceipt: (id) => {
      const row = db
        .prepare('SELECT binding,hash FROM ocean_capture_receipts WHERE request_id=?')
        .get(id);
      return row ? { binding: String(row['binding']), hash: String(row['hash']) } : null;
    },
    putCaptureReceipt: (id, r) => {
      db.prepare('INSERT INTO ocean_capture_receipts VALUES(?,?,?)').run(id, r.binding, r.hash);
    },
  };
}
