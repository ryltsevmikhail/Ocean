import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { Bot } from '@runnets/domain';
import { initializeSchema } from './schema.js';
import { SqliteConversationStore } from './conversations.js';
import { SqliteProviderConnections } from './provider-connection-storage.js';

const opened: DatabaseSync[] = [];
const bot: Bot = {
  id: 'dev',
  workspaceId: 'w',
  handle: 'dev',
  name: 'Dev',
  role: 'Build',
  provider: 'deepseek',
  model: 'per-bot-model',
  profileVersion: 3,
};
function previous() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  opened.push(db);
  initializeSchema(db);
  db.exec(`DROP TABLE IF EXISTS ocean_room_model_policies;
    DROP TABLE IF EXISTS ocean_bot_model_bindings;
    DROP TABLE IF EXISTS ocean_model_connection_receipts;
    DROP TABLE IF EXISTS ocean_model_connections;
    UPDATE meta SET value='19' WHERE key='schema_version';
    INSERT INTO ocean_workspace VALUES(1,'w','/project')`);
  const insert = db.prepare('INSERT INTO ocean_bots VALUES(?,?,?,?,?,?,?,?)');
  for (const b of [
    bot,
    { ...bot, id: 'review', handle: 'review', model: 'other-model' },
    { ...bot, id: 'unknown', handle: 'unknown', provider: 'vendor', model: 'vendor-model' },
  ])
    insert.run(
      b.id,
      b.workspaceId,
      b.handle,
      b.name,
      b.role,
      b.provider,
      b.model,
      b.profileVersion,
    );
  return db;
}
function legacy(db: DatabaseSync, provider: string, intent: string, revision: number) {
  db.prepare('INSERT INTO ocean_provider_connections VALUES(?,?,?,?,?,?,?,?,?)').run(
    provider,
    'shared-default',
    'opaque-ref',
    intent,
    revision,
    'old-request',
    'old-digest',
    null,
    '2026-11-04T00:00:00Z',
  );
}
function connection(db: DatabaseSync, id: string): unknown {
  return JSON.parse(
    String(
      db.prepare('SELECT payload FROM ocean_model_connections WHERE connection_id=?').get(id)?.[
        'payload'
      ],
    ),
  ) as unknown;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

it('migrates separate bot models without changing legacy bots, turns, history or receipt bytes', () => {
  const db = previous();
  legacy(db, 'deepseek', 'active', 7);
  db.exec(`INSERT INTO ocean_rooms VALUES('room','w','direct','dev',NULL);
    INSERT INTO ocean_members VALUES('w','room','dev')`);
  const turn = ' { "id":"turn", "status":"completed", "bot":' + JSON.stringify(bot) + ' } ';
  db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,?)').run(
    'turn',
    'w',
    'room',
    'run',
    'completed',
    turn,
    null,
  );
  db.prepare('INSERT INTO ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'message',
    'w',
    'room',
    1,
    'user',
    'dev',
    'old text',
    'then',
    null,
    null,
  );
  db.prepare('INSERT INTO ocean_receipts VALUES(?,?,?)').run(
    'old',
    'digest',
    ' { "kind":"bot", "data":' + JSON.stringify(bot) + ' } ',
  );
  db.prepare('INSERT INTO ocean_provider_receipts VALUES(?,?,?,?)').run(
    'old-provider',
    'deepseek',
    'old-digest',
    ' { "binding":"old-digest", "result":{} } ',
  );
  const tables = [
    'ocean_bots',
    'ocean_chat_turns',
    'ocean_messages',
    'ocean_receipts',
    'ocean_provider_connections',
    'ocean_provider_receipts',
  ];
  const snapshot = () => tables.map((table) => db.prepare('SELECT * FROM ' + table).all());
  const before = snapshot();
  initializeSchema(db);
  const store = new SqliteConversationStore(db);
  store.atomic((tx) => {
    expect(tx.modelBinding(bot.id)).toEqual({
      connectionId: 'legacy:deepseek',
      modelId: bot.model,
    });
    expect(tx.modelBinding('review')).toEqual({
      connectionId: 'legacy:deepseek',
      modelId: 'other-model',
    });
    expect(tx.bot(bot.id)).toEqual(bot);
  });
  expect(connection(db, 'legacy:deepseek')).toMatchObject({
    defaultModelId: 'shared-default',
    revision: 7,
    intent: 'active',
    secretRef: 'opaque-ref',
    endpoint: 'https://api.deepseek.com',
    configuredAfterRestore: false,
  });
  expect(snapshot()).toEqual(before);
  initializeSchema(db);
  expect(snapshot()).toEqual(before);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it.each(['active', 'disconnected', 'pending'])(
  'preserves %s intent and revision without activating missing vendors',
  (intent) => {
    const db = previous();
    legacy(db, 'deepseek', intent, 4);
    initializeSchema(db);
    expect(connection(db, 'legacy:deepseek')).toMatchObject({
      intent,
      revision: 4,
      legacyEnvironment: true,
    });
    expect(new SqliteProviderConnections(db).read('deepseek')).toMatchObject({
      intent,
      revision: 4,
    });
    expect(connection(db, 'legacy:vendor')).toMatchObject({
      intent: 'unconfigured',
      revision: 0,
      secretRef: null,
      endpoint: null,
      defaultModelId: null,
      kind: 'cloud',
      auth: 'api_key',
      legacyEnvironment: false,
    });
  },
);

it('preserves unknown legacy vendor metadata without inventing an endpoint or environment seam', () => {
  const db = previous();
  legacy(db, 'vendor', 'active', 3);
  initializeSchema(db);
  expect(connection(db, 'legacy:vendor')).toMatchObject({
    providerId: 'vendor',
    intent: 'active',
    revision: 3,
    endpoint: null,
    defaultModelId: 'shared-default',
    secretRef: 'opaque-ref',
    legacyEnvironment: false,
  });
});

it('creates only inert revision-zero placeholders for missing rows and never mutates on reads', () => {
  const db = previous();
  initializeSchema(db);
  const before = db.prepare('SELECT * FROM ocean_model_connections ORDER BY connection_id').all();
  expect(connection(db, 'legacy:deepseek')).toMatchObject({
    intent: 'unconfigured',
    revision: 0,
    secretRef: null,
    legacyEnvironment: true,
    defaultModelId: null,
  });
  expect(new SqliteProviderConnections(db).read('deepseek')).toBeNull();
  const store = new SqliteConversationStore(db);
  db.exec("DELETE FROM ocean_bot_model_bindings WHERE bot_id='dev'");
  expect(store.atomic((tx) => tx.modelBinding('dev'))).toBeNull();
  expect(store.atomic((tx) => tx.bot('dev'))).toEqual(bot);
  expect(db.prepare('SELECT * FROM ocean_model_connections ORDER BY connection_id').all()).toEqual(
    before,
  );
});

it('rolls back migration rows and version publication together, then reruns safely', () => {
  const db = previous();
  legacy(db, 'deepseek', 'pending', 2);
  db.exec(
    "CREATE TRIGGER stop_model BEFORE UPDATE ON meta WHEN NEW.key='schema_version' AND NEW.value='26' BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END",
  );
  expect(() => initializeSchema(db)).toThrow('synthetic interruption');
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '19',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_model_connections'").get(),
  ).toBeUndefined();
  db.exec('DROP TRIGGER stop_model');
  initializeSchema(db);
  expect(connection(db, 'legacy:deepseek')).toMatchObject({ intent: 'pending', revision: 2 });
  initializeSchema(db);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ocean_bot_model_bindings').get()?.['n']).toBe(3);
});
