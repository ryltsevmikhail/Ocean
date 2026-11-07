import { omitModelConnectionSchema } from '../test-fixtures/model-schema.js';
import { expect, it } from 'vitest';
import type { CodingTask } from '@runnets/domain';
import { openSqliteStore } from './store.js';
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
  initializeSchema,
  openDatabase,
} from './schema.js';
it('migrates a schema-13 coding table to 14 without changing any task row', () => {
  const path = ':memory:';
  const store = openSqliteStore({ path });
  store.close();
  const db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
  try {
    db.exec("INSERT INTO ocean_workspace VALUES(1,'ws','/project')");
    db.exec(
      "INSERT INTO ocean_bots VALUES('dev','ws','dev','Dev','Role','test','test',1),('review','ws','review','Review','Role','test','test',1)",
    );
    db.exec(
      "INSERT INTO ocean_rooms(id,workspace_id,kind,bot_id) VALUES('room','ws','direct','dev'),('review-room','ws','direct','review')",
    );
    db.exec("INSERT INTO ocean_members VALUES('ws','room','dev'),('ws','review-room','review')");
    const task = {
      id: 'task',
      workspaceId: 'ws',
      projectRoot: '/project',
      baseCommit: 'a'.repeat(40),
      worktreeRoot: null,
      ownerRoomId: 'room',
      devBotId: 'dev',
      reviewBotId: 'review',
      reviewRoomId: 'review-room',
      status: 'reserved',
      policyVersion: 1,
      policy: {
        version: 1,
        devCapabilities: ['project_read'],
        reviewCapabilities: ['changeset_read'],
        testPresets: [],
      },
      lease: {
        ownerId: 'owner',
        taskId: 'task',
        requestId: 'start',
        binding: 'binding',
        kind: 'coding',
        projectRoot: '/project',
        token: 'token',
      },
      createdAt: '2026-11-03T00:00:00.000Z',
    } satisfies CodingTask;
    db.prepare('INSERT INTO ocean_coding_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      task.id,
      task.workspaceId,
      task.projectRoot,
      task.ownerRoomId,
      task.devBotId,
      task.reviewRoomId,
      task.reviewBotId,
      task.status,
      task.policyVersion,
      JSON.stringify(task),
    );
    // Downgrade the table and version to their accepted schema-13 shape.
    omitModelConnectionSchema(db);
    db.exec(`DROP TABLE ocean_coding_finalizations;
    CREATE TABLE ocean_coding_tasks_v13(
     id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_root TEXT NOT NULL,
     owner_room_id TEXT NOT NULL,dev_bot_id TEXT NOT NULL,review_room_id TEXT NOT NULL,review_bot_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('reserved','cancelled')),
     policy_version INTEGER NOT NULL CHECK(policy_version=1),payload TEXT NOT NULL,
     UNIQUE(workspace_id,id),
     FOREIGN KEY(workspace_id) REFERENCES ocean_workspace(id),
     FOREIGN KEY(owner_room_id,dev_bot_id) REFERENCES ocean_members(room_id,bot_id),
     FOREIGN KEY(review_room_id,review_bot_id) REFERENCES ocean_members(room_id,bot_id),
     CHECK(dev_bot_id!=review_bot_id)
    ) STRICT;
    INSERT INTO ocean_coding_tasks_v13 SELECT * FROM ocean_coding_tasks;
    DROP TABLE ocean_coding_tasks;
    ALTER TABLE ocean_coding_tasks_v13 RENAME TO ocean_coding_tasks;
    CREATE UNIQUE INDEX ocean_coding_project_hold ON ocean_coding_tasks(project_root) WHERE status='reserved';
    UPDATE meta SET value='13' WHERE key='schema_version';`);
    initializeSchema(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      String(SCHEMA_VERSION),
    );
    expect(db.prepare('SELECT payload FROM ocean_coding_tasks').get()?.['payload']).toBe(
      JSON.stringify(task),
    );
    expect(
      db.prepare("SELECT 1 FROM ocean_coding_finalizations WHERE state='finalizing'").get(),
    ).toBeUndefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
