import { fixture, seed } from '../test-fixtures/room-slices-v27.js';
import { RoomTaskPersistence } from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDatabase, snapshotDatabase, openSqliteStore } from './index.js';
it('migrates genuine populated BASE v27 without inventing proof, history or wake', () => {
  expect(fixture.base).toBe('b83121a5bcde505d648b845ced816a514466a933');
  expect(
    createHash('sha256')
      .update(JSON.stringify(fixture) + '\n')
      .digest('hex'),
  ).toBe('f6a676dad8cac5a98b661b6b01bf22bc6385146a3eeeaaf3fa3e1074254a886d');
  const dir = mkdtempSync(join(tmpdir(), 'room-v27-')),
    path = join(dir, 'store.sqlite');
  const db = new DatabaseSync(path);
  try {
    seed(db);
    db.close();
    const store = openSqliteStore({ path });
    try {
      const read = new DatabaseSync(path);
      try {
        expect(
          read.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
        ).toBe('29');
        const service = new RoomTaskPersistence({
          store: store.conversations,
          ownerId: 'owner',
          sha256: (s) => createHash('sha256').update(s).digest('hex'),
          clock: {
            now() {
              throw Error('replay clock');
            },
          },
          nextId() {
            throw Error('replay allocation');
          },
        });
        expect(
          service.start({
            workspaceId: 'ws_fixture',
            roomId: 'room',
            requestId: 'start',
            text: 'work',
            initialBotIds: ['a', 'b'],
            participants: ['a', 'b', 'c'].map((botId) => ({ botId, grantReferences: [] })),
            mandate: { projectId: null, codingTaskId: null, permissions: [] },
          }),
        ).toEqual({
          ok: true,
          value: {
            version: 1,
            workspaceId: 'ws_fixture',
            roomId: 'room',
            rootId: 'd_1',
            messageId: 'd_2',
            seq: 1,
            deliveries: [
              { botId: 'a', taskId: 'd_3', deliveryId: 'd_4' },
              { botId: 'b', taskId: 'd_5', deliveryId: 'd_6' },
            ],
          },
        });
        expect(
          service.send(
            {
              turnId: 'turn_d_3',
              taskRunId: 'tr_turn_d_3',
              attemptId: 'at_turn_d_3',
              callId: 'at_turn_d_3_r1_call',
            },
            { kind: 'delegate', toBotId: 'b', text: 'v27 inert wait' },
          ),
        ).toEqual({
          ok: true,
          value: {
            version: 1,
            workspaceId: 'ws_fixture',
            roomId: 'room',
            rootId: 'd_1',
            messageId: 'd_7',
            seq: 2,
            deliveries: [{ botId: 'b', taskId: 'd_8', deliveryId: 'd_9' }],
          },
        });
        for (const [table, rows] of Object.entries(fixture.rows))
          if (table !== 'meta')
            expect(
              read
                .prepare(`SELECT ${Object.keys(rows[0] ?? {}).join(',') || '*'} FROM ${table}`)
                .all(),
              table,
            ).toEqual(rows);
        expect(
          read
            .prepare('SELECT host_scope FROM ocean_room_tasks WHERE host_scope IS NOT NULL')
            .all(),
        ).toEqual([]);
        expect(read.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(
          read
            .prepare("SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='result'")
            .get()?.['n'],
        ).toBe(0);
        expect(
          store.conversations
            .atomic((tx) => tx.chatTurns())
            .every((t) => t.roomHandoff === undefined),
        ).toBe(true);
      } finally {
        read.close();
      }
    } finally {
      store.close();
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps an unmigrated genuine v27 snapshot readable and held through doctor/backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-v27-maintenance-')),
    path = join(dir, 'old.sqlite'),
    copy = join(dir, 'copy.sqlite');
  const db = new DatabaseSync(path);
  try {
    seed(db);
    expect(
      new SqliteConversationStore(db, { legacySchema: true }).atomic((tx) =>
        tx.history('room', 0, 20),
      ),
    ).toHaveLength(2);
    expect(inspectDatabase(path)).toMatchObject({
      status: 'ok',
      summary: { schema: 27, heldRooms: 1, unfinishedRuns: 1 },
    });
    await expect(snapshotDatabase(path, copy)).resolves.toMatchObject({ schema: 27, heldRooms: 1 });
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '27',
    );
    const snapshot = new DatabaseSync(copy);
    try {
      expect(
        snapshot.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('27');
      expect(snapshot.prepare('SELECT * FROM ocean_room_tasks').all()).toEqual(
        fixture.rows['ocean_room_tasks'],
      );
      expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      snapshot.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
