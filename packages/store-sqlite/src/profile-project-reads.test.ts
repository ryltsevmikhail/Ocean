import { expect, it } from 'vitest';
import { claimFixture } from '../test-fixtures/finalization-claims.js';

it('pages only exact-root tasks with matching owner and current dev membership', () => {
  const f = claimFixture();
  try {
    const { task, store, db } = f;
    const other = (id: string, root: string, ownerId: string, ownerRoomId = task.ownerRoomId) => ({
      ...task,
      id,
      projectRoot: root,
      ownerRoomId,
      status: 'cancelled' as const,
      worktreeRoot: null,
      lease: { ...task.lease, taskId: id, projectRoot: root, ownerId },
    });
    db.exec(
      "INSERT INTO ocean_rooms(id,workspace_id,kind,title) VALUES('former-room','ws','group','Former'); INSERT INTO ocean_members VALUES('ws','former-room','dev')",
    );
    store.coding.atomic((tx) => {
      tx.putTask(other('a-foreign', '/project', 'other-owner'));
      tx.putTask(other('b-child', '/project/child', 'owner'));
      tx.putTask(other('c-former-member', '/project', 'owner', 'former-room'));
      tx.putTask(other('z-task', '/project', 'owner'));
    });
    db.exec(
      "PRAGMA foreign_keys=OFF; DELETE FROM ocean_members WHERE room_id='former-room' AND bot_id='dev'",
    );
    const summary = {
      id: 'task',
      status: 'reserved',
      ownerRoomId: 'room',
      devBotId: 'dev',
      reviewRoomId: 'review-room',
      reviewBotId: 'review',
      worktreeReady: true,
    };
    const reads = store.openProfileReads('owner');
    expect(() => reads.codingTasks('foreign', '/project', '', 1)).toThrow('unknown_workspace');
    expect(reads.codingTasks('ws', '/project', '', 1)).toEqual([summary]);
    expect(reads.codingTasks('ws', '/project', 'task', 1)).toEqual([
      { ...summary, id: 'z-task', status: 'cancelled', worktreeReady: false },
    ]);
    db.prepare("UPDATE ocean_worktrees SET state='preparing' WHERE task_id='task'").run();
    expect(reads.codingTasks('ws', '/project', '', 1)).toEqual([
      { ...summary, worktreeReady: false },
    ]);
    db.prepare("DELETE FROM ocean_members WHERE bot_id='dev'").run();
    expect(reads.codingTasks('ws', '/project', '', 1)).toEqual([]);
  } finally {
    f.close();
  }
});
