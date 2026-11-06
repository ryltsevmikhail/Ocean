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
      summary: { schema: 27, messages: 2, unfinishedRuns: 1, heldRooms: 1 },
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
