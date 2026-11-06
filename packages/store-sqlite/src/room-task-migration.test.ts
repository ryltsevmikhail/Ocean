import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema } from './schema.js';
import { inspectDatabase, snapshotDatabase } from './maintenance.js';
import { SqliteConversationStore } from './conversations.js';
import { ownerGrant, serviceConnection } from '../../../test-fixtures/service-authority.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
import { roomTasks } from '../test-fixtures/room-tasks.js';
function predecessor(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec(
    ['ocean-schema-v26.sql', 'ocean-schema-v26-extensions.sql']
      .map((name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))
      .join(''),
  );
  const store = new SqliteConversationStore(db, { legacySchema: true });
  store.atomic((tx) => {
    tx.putWorkspace({ id: 'ws', root: '/disposable' });
    tx.putBot({
      id: 'bot',
      workspaceId: 'ws',
      handle: 'bot',
      name: 'Bot',
      role: 'Role',
      provider: 'fixture',
      model: 'one',
      profileVersion: 1,
    });
    tx.putRoom({ id: 'room', workspaceId: 'ws', kind: 'group', title: 'Team', botIds: ['bot'] });
    tx.putRoom({ id: 'direct', workspaceId: 'ws', kind: 'direct', botId: 'bot' });
    tx.putMessage({
      id: 'input',
      workspaceId: 'ws',
      roomId: 'room',
      seq: 1,
      author: 'user',
      targetBotId: null,
      body: 'old text',
      createdAt: '2026-11-05T00:00:00Z',
    });
    const turn = {
      id: 'done',
      workspaceId: 'ws',
      roomId: 'room',
      requestId: 'old',
      taskRunId: 'tr_done',
      inboundMessageId: 'input',
      readThroughSeq: 1,
      bot: tx.bot('bot')!,
      status: 'completed' as const,
      text: 'reply',
      preparedVersion: 1,
      stopReason: 'end_turn' as const,
    };
    tx.putChatTurn(turn);
    const final = {
      id: 'reply_done',
      workspaceId: 'ws',
      roomId: 'room',
      seq: 2,
      author: 'bot' as const,
      authorBotId: 'bot',
      targetBotId: 'bot',
      turnId: 'done',
      body: 'reply',
      createdAt: '2026-11-05T00:00:01Z',
    };
    tx.putMessage(final);
    tx.putReceipt('old', { binding: 'old-binding', reply: { kind: 'message', data: final } });
    tx.putChatTurn({ ...turn, id: 'uncertain', taskRunId: 'tr_uncertain', status: 'uncertain' });
    tx.putChatTurn({
      ...turn,
      id: 'queued',
      taskRunId: 'tr_queued',
      status: 'queued',
      broadcast: { version: 1, batchId: 'batch', position: 0 },
    });
  });
  db.prepare('INSERT INTO ocean_reviews VALUES(?,?,?,?,?,?,?)').run(
    'review',
    'ws',
    'room',
    'tr_uncertain',
    'uncertain',
    'input',
    JSON.stringify({ id: 'review' }),
  );
  db.exec(
    "UPDATE ocean_chat_turns SET review_id='review',payload=json_set(payload,'$.continuationReviewId','review') WHERE id='uncertain'",
  );
  db.prepare('INSERT INTO ocean_broadcast_batches VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'batch',
    'ws',
    'room',
    'batch-request',
    'binding',
    'input',
    1,
    '[]',
    'paused',
    1,
    'now',
    'now',
  );
  db.exec(
    "INSERT INTO ocean_desktop_uploads VALUES('metadata','room','fixture.txt',0,'digest','opaque metadata')",
  );
  new SqliteServiceAuthority(db).atomic((tx) => {
    tx.putConnection(serviceConnection, null);
    tx.putGrant(ownerGrant, null);
  });
  return db;
}
function logicalRows(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta' ORDER BY name",
      )
      .all()
      .map((r) => [
        String(r['name']),
        db.prepare(`SELECT * FROM ${String(r['name'])} ORDER BY rowid`).all(),
      ]),
  );
}
it('publishes v28 with two durable task tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('ocean_room_tasks','ocean_room_deliveries')",
        )
        .all(),
    ).toHaveLength(2);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '28',
    );
  } finally {
    db.close();
  }
});
it('migrates a genuine BASE v26 disposable snapshot preserving reply, review, batch, grants and attachment metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'room-v26-')),
    path = join(root, 'v26.sqlite');
  let db = predecessor(path);
  try {
    const before = logicalRows(db);
    db.close();
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    initializeSchema(db);
    const after = logicalRows(db);
    for (const [table, rows] of Object.entries(before)) expect(after[table], table).toEqual(rows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const store = new SqliteConversationStore(db);
    expect(store.atomic((tx) => tx.receipt('old'))?.reply).toMatchObject({
      kind: 'message',
      data: { id: 'reply_done' },
    });
    expect(() =>
      db.exec(
        "INSERT INTO ocean_messages VALUES('duplicate','ws','room',3,'bot','bot','again','now','bot','done')",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "INSERT INTO ocean_messages VALUES('untargeted','ws','direct',1,'user',NULL,'no','now',NULL,NULL)",
      ),
    ).toThrow('direct message requires a target');
    store.atomic((tx) => tx.putBot({ ...tx.bot('bot')!, id: 'peer', handle: 'peer' }));
    db.exec("INSERT INTO ocean_members VALUES('ws','room','peer')");
    expect(() =>
      db.exec("UPDATE ocean_messages SET target_bot_id='peer' WHERE id='reply_done'"),
    ).toThrow('immutable conversation message');
    expect(() =>
      db.exec(
        "INSERT INTO ocean_messages VALUES('another-final','ws','room',3,'bot','bot','again','now','bot','done')",
      ),
    ).toThrow();
    expect(
      db.prepare("SELECT target_bot_id FROM ocean_messages WHERE id='reply_done'").get()?.[
        'target_bot_id'
      ],
    ).toBe('bot');
    expect(store.atomic((tx) => tx.activeChatTurn('room'))).toBeNull();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('rolls interrupted v28 publication back to exact predecessor schema and logical rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'room-v26-')),
    db = predecessor(join(root, 'v26.sqlite'));
  try {
    db.exec(
      "CREATE TRIGGER stop_27 BEFORE UPDATE ON meta WHEN NEW.value='28' BEGIN SELECT RAISE(ABORT,'v27 interrupted'); END",
    );
    const rows = logicalRows(db),
      ddl = db.prepare('SELECT * FROM sqlite_master ORDER BY rowid').all();
    expect(() => initializeSchema(db)).toThrow('v27 interrupted');
    expect(logicalRows(db)).toEqual(rows);
    expect(db.prepare('SELECT * FROM sqlite_master ORDER BY rowid').all()).toEqual(ddl);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
      '26',
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('DROP TRIGGER stop_27');
    initializeSchema(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('inspects and snapshots inert current state and rejects unsupported future29', async () => {
  const f = roomTasks();
  try {
    const started = f.service.start(f.input);
    expect(started.ok).toBe(true);
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']),
      copy = path + '.snapshot';
    expect(inspectDatabase(path)).toMatchObject({
      status: 'ok',
      summary: { schema: 28, heldRooms: 1, unfinishedRuns: 0 },
    });
    await expect(snapshotDatabase(path, copy)).resolves.toMatchObject({ schema: 28, heldRooms: 1 });
    const db = new DatabaseSync(copy);
    try {
      initializeSchema(db);
      expect(
        new SqliteConversationStore(db).atomic((tx) => tx.history('room', 0, 10)),
      ).toHaveLength(1);
      db.exec("UPDATE meta SET value='29' WHERE key='schema_version'");
      expect(() => initializeSchema(db)).toThrow(/newer/);
      expect(inspectDatabase(copy)).toEqual({ status: 'unsupported_schema' });
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

it('installs the history update guard when reopening an already-published v27 database', () => {
  const f = roomTasks();
  try {
    const started = f.service.start(f.input);
    if (!started.ok) throw Error('start');
    f.db!.exec('DROP TRIGGER IF EXISTS ocean_message_immutable');
    initializeSchema(f.db!);
    expect(() =>
      f
        .db!.prepare("UPDATE ocean_messages SET body='changed' WHERE id=?")
        .run(started.value.messageId),
    ).toThrow('immutable conversation message');
    expect(f.service.start(f.input)).toEqual(started);
  } finally {
    f.close();
  }
});
