import { expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RoomTaskPersistence } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  roomTasks,
  attachRoomActor,
} from '../../../../packages/store-sqlite/test-fixtures/room-tasks.js';
import { backupProfile, restoreProfile } from './snapshots.js';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const rows = (db: DatabaseSync) =>
  Object.fromEntries(
    [
      'ocean_room_tasks',
      'ocean_room_deliveries',
      'ocean_messages',
      'ocean_receipts',
      'ocean_chat_turns',
      'events',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
it('restores a source-deleted format2 D archive, replays start/peer receipts and refuses fresh admissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-room-archive-'));
  const source = join(root, 'source'),
    archive = join(root, 'archive'),
    destination = join(root, 'restored');
  mkdirSync(source, { mode: 0o700 });
  const path = join(source, 'runtime.sqlite'),
    f = roomTasks(path);
  let sourceOpen = true;
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'archived peer text' };
    const sent = f.service.send(actor, request);
    if (!sent.ok) throw Error('send');
    const original = rows(f.db!);
    f.close();
    sourceOpen = false;
    chmodSync(path, 0o600);
    const manifest = await backupProfile(source, archive);
    expect(manifest).toMatchObject({
      format: 2,
      summary: { schema: 28, messages: 2, unfinishedRuns: 1, heldRooms: 1 },
    });
    const archiveDigest = digest(join(archive, 'runtime.sqlite'));
    expect(archiveDigest).toBe(manifest.sha256);
    rmSync(source, { recursive: true });
    expect(restoreProfile(archive, destination)).toEqual(manifest);
    expect(digest(join(archive, 'runtime.sqlite'))).toBe(archiveDigest);
    const restoredPath = join(destination, 'runtime.sqlite'),
      store = openSqliteStore({ path: restoredPath }),
      db = new DatabaseSync(restoredPath);
    try {
      expect(store.restoration.origin()?.manifest).toEqual(manifest);
      expect(rows(db)).toEqual(original);
      const service = new RoomTaskPersistence({
        ...f.service.deps,
        store: store.conversations,
        clock: {
          now: () => {
            throw Error('archived receipt must not consult clock');
          },
        },
        nextId: () => {
          throw Error('quarantine must not allocate');
        },
      });
      expect(service.start(f.input)).toEqual(start);
      expect(service.send(actor, request)).toEqual(sent);
      expect(
        store.conversations.atomic((tx) =>
          tx.roomTasks!.origin(actor.turnId, actor.taskRunId, actor.attemptId, true),
        ),
      ).not.toBeNull();
      const before = rows(db);
      expect(service.start({ ...f.input, requestId: 'fresh-restored-start' })).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
      expect(service.send({ ...actor, callId: actor.callId + '-fresh' }, request)).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
      expect(rows(db)).toEqual(before);
      expect(store.conversations.atomic((tx) => tx.history('room', 0, 10))).toMatchObject([
        { id: start.value.messageId, author: 'user' },
        {
          id: sent.value.messageId,
          author: 'bot',
          authorBotId: 'a',
          targetBotId: 'b',
          body: 'archived peer text',
        },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
      store.close();
    }
  } finally {
    if (sourceOpen) f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('restores a source-deleted genuine v27 format2 archive to v28 with inert receipt replay and holds', async () => {
  const { seed } =
    await import('../../../../packages/store-sqlite/test-fixtures/room-slices-v27.js');
  const { claimRoomDelivery } = await import('@runnets/application');
  const root = mkdtempSync(join(tmpdir(), 'ocean-genuine27-'));
  const source = join(root, 'source'),
    archive = join(root, 'archive'),
    destination = join(root, 'restored');
  mkdirSync(source, { mode: 0o700 });
  const path = join(source, 'runtime.sqlite'),
    db = new DatabaseSync(path);
  try {
    seed(db);
    const original = rows(db);
    db.close();
    chmodSync(path, 0o600);
    const manifest = await backupProfile(source, archive);
    expect(manifest).toMatchObject({
      format: 2,
      summary: { schema: 27, messages: 2, unfinishedRuns: 1, heldRooms: 1 },
    });
    const archiveDigest = digest(join(archive, 'runtime.sqlite'));
    expect(archiveDigest).toBe(manifest.sha256);
    rmSync(source, { recursive: true });
    expect(restoreProfile(archive, destination)).toEqual(manifest);
    expect(digest(join(archive, 'runtime.sqlite'))).toBe(archiveDigest);
    const restoredPath = join(destination, 'runtime.sqlite'),
      store = openSqliteStore({ path: restoredPath }),
      restored = new DatabaseSync(restoredPath);
    try {
      expect(
        restored.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
      ).toBe('28');
      expect(store.restoration.origin()?.manifest).toEqual(manifest);
      expect(rows(restored)).toEqual(original);
      const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
      const deps = {
        store: store.conversations,
        ownerId: 'owner',
        sha256,
        clock: {
          now() {
            throw Error('archived replay clock');
          },
        },
        nextId() {
          throw Error('archived replay allocation');
        },
      };
      const service = new RoomTaskPersistence(deps);
      const input = {
        workspaceId: 'ws_fixture',
        roomId: 'room',
        requestId: 'start',
        text: 'work',
        initialBotIds: ['a', 'b'],
        participants: ['a', 'b', 'c'].map((botId) => ({ botId, grantReferences: [] })),
        mandate: { projectId: null, codingTaskId: null, permissions: [] },
      };
      const actor = {
        turnId: 'turn_d_3',
        taskRunId: 'tr_turn_d_3',
        attemptId: 'at_turn_d_3',
        callId: 'at_turn_d_3_r1_call',
      };
      const request = { kind: 'delegate', toBotId: 'b', text: 'v27 inert wait' };
      expect(service.start(input)).toEqual({
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
      expect(service.send(actor, request)).toEqual({
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
      expect(service.start({ ...input, requestId: 'fresh' })).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
      expect(service.send({ ...actor, callId: actor.callId + '_fresh' }, request)).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
      const child = restored
        .prepare("SELECT id FROM ocean_room_deliveries WHERE kind='delegate'")
        .get()!;
      expect(
        claimRoomDelivery(
          {
            ...deps,
            clock: { now: () => new Date('2026-11-06T00:00:00Z') },
            resolver: {
              resolve() {
                throw Error('restored work must not resolve provider');
              },
            },
          },
          String(child['id']),
        ),
      ).toEqual({ kind: 'held' });
      expect(rows(restored)).toEqual(original);
      expect(
        store.conversations
          .atomic((tx) => tx.chatTurns())
          .every((t) => t.roomHandoff === undefined),
      ).toBe(true);
      expect(
        restored
          .prepare("SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='result'")
          .get()?.['n'],
      ).toBe(0);
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      restored.close();
      store.close();
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
