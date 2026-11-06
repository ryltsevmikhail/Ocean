import { omitRoomTaskSchema } from '../test-fixtures/room-task-v26.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryConversationStore } from '@runnets/store';
import {
  unconfiguredModelConnection,
  type ConversationStore,
  type ModelConnectionStorePort,
} from '@runnets/application';
import type { Bot } from '@runnets/domain';
import { SqliteConversationStore } from './conversations.js';
import { SqliteModelConnections } from './model-connection-storage.js';
import { initializeSchema } from './schema.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const bot: Bot = {
  id: 'dev',
  workspaceId: 'w',
  handle: 'dev',
  name: 'Dev',
  role: 'Build',
  provider: 'vendor',
  model: 'individual',
  profileVersion: 1,
};
for (const adapter of ['sqlite', 'memory'] as const)
  describe(adapter + ' model bindings', () => {
    function setup(): { store: ConversationStore; connections: ModelConnectionStorePort } {
      let store: ConversationStore, connections: ModelConnectionStorePort;
      if (adapter === 'sqlite') {
        const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
        databases.push(db);
        initializeSchema(db);
        store = new SqliteConversationStore(db);
        connections = new SqliteModelConnections(db);
      } else {
        const memory = new InMemoryConversationStore();
        store = memory;
        connections = memory;
      }
      store.atomic((tx) => tx.putWorkspace({ id: 'w', root: '/project' }));
      return { store, connections };
    }
    it('inserts bot and inert binding atomically without changing legacy Bot shape or shared defaults', () => {
      const { store, connections } = setup();
      store.atomic((tx) => tx.putBot(bot));
      expect(store.atomic((tx) => tx.bot(bot.id))).toEqual(bot);
      expect(store.atomic((tx) => tx.modelBinding(bot.id))).toEqual({
        connectionId: 'legacy:vendor',
        modelId: 'individual',
      });
      const before = connections.read('legacy:vendor');
      expect(before).toMatchObject({
        revision: 0,
        intent: 'unconfigured',
        secretRef: null,
        endpoint: null,
        legacyEnvironment: false,
      });
      connections.put({ ...before!, defaultModelId: 'shared-default' }, 0);
      expect(store.atomic((tx) => tx.modelBinding(bot.id)?.modelId)).toBe('individual');
      expect(store.atomic((tx) => tx.bots())).toEqual([bot]);
      expect(() => store.atomic((tx) => tx.putBot(bot))).toThrow();
    });
    it('rolls back a newly created placeholder, binding, bot and receipt on transaction failure', () => {
      const { store, connections } = setup();
      expect(() =>
        store.atomic((tx) => {
          tx.putBot(bot);
          tx.putReceipt('new', { binding: 'b', reply: { kind: 'bot', data: bot } });
          expect(tx.modelBinding(bot.id)).not.toBeNull();
          throw Error('publication failure');
        }),
      ).toThrow('publication failure');
      expect(store.atomic((tx) => tx.bot(bot.id))).toBeNull();
      expect(store.atomic((tx) => tx.modelBinding(bot.id))).toBeNull();
      expect(store.atomic((tx) => tx.receipt('new'))).toBeNull();
      expect(connections.read('legacy:vendor')).toBeNull();
    });
    it('rebinds only the chosen bot, rejects missing references and rolls back failed binding changes', () => {
      const { store, connections } = setup();
      store.atomic((tx) => {
        tx.putBot(bot);
        tx.putBot({ ...bot, id: 'other', handle: 'other', model: 'other-model' });
      });
      const local = {
        ...unconfiguredModelConnection('local'),
        connectionId: 'local',
        kind: 'local' as const,
        auth: 'none' as const,
      };
      connections.put(local, null);
      const binding = { connectionId: 'local', modelId: 'local-model' };
      expect(() =>
        store.atomic((tx) => {
          tx.putModelBinding(bot.id, binding);
          throw Error('failed');
        }),
      ).toThrow('failed');
      expect(store.atomic((tx) => tx.modelBinding(bot.id)?.connectionId)).toBe('legacy:vendor');
      store.atomic((tx) => tx.putModelBinding(bot.id, binding));
      Reflect.set(binding, 'modelId', 'mutated');
      expect(store.atomic((tx) => tx.modelBinding(bot.id)?.modelId)).toBe('local-model');
      expect(store.atomic((tx) => tx.modelBinding('other')?.modelId)).toBe('other-model');
      expect(() => store.atomic((tx) => tx.putModelBinding('absent', binding))).toThrow();
      expect(() =>
        store.atomic((tx) => tx.putModelBinding(bot.id, { connectionId: 'absent', modelId: 'm' })),
      ).toThrow();
      expect(store.atomic((tx) => tx.bot(bot.id))).toEqual(bot);
    });
    it('guards connection revisions and keeps receipt snapshots detached across later writes', () => {
      const { connections } = setup();
      const initial = unconfiguredModelConnection('local');
      connections.put(initial, null);
      const active = {
        ...initial,
        intent: 'active' as const,
        revision: 1,
        endpoint: 'http://127.0.0.1:8000',
        defaultModelId: 'model',
      };
      connections.activate(active, 0, {
        requestId: 'activate',
        value: { binding: 'digest', result: active },
      });
      connections.put({ ...active, revision: 2, defaultModelId: 'new-model' }, 1);
      expect(() => connections.put(active, 1)).toThrow('revision_conflict');
      expect(() =>
        connections.activate({ ...active, revision: 3 }, 2, {
          requestId: 'activate',
          value: { binding: 'other', result: { ...active, revision: 3 } },
        }),
      ).toThrow('request_conflict');
      const receipt = connections.receipt('activate');
      expect(receipt?.result.defaultModelId).toBe('model');
      Reflect.set(receipt!.result, 'defaultModelId', 'changed');
      expect(connections.receipt('activate')?.result.defaultModelId).toBe('model');
      expect(connections.read(active.connectionId)?.revision).toBe(2);
    });
  });

it('requires migrated schema by default and makes pre-current fixture behavior explicit', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  omitRoomTaskSchema(db);
  db.exec("UPDATE meta SET value='19' WHERE key='schema_version'");
  expect(() => new SqliteConversationStore(db).atomic((tx) => tx.bots())).toThrow(
    'unsupported_schema',
  );
  const fixture = new SqliteConversationStore(db, { legacySchema: true });
  fixture.atomic((tx) => {
    tx.putWorkspace({ id: 'w', root: '/project' });
    tx.putBot(bot);
  });
  expect(fixture.atomic((tx) => tx.modelBinding(bot.id))).toBeNull();
  expect(() =>
    fixture.atomic((tx) => tx.putModelBinding(bot.id, { connectionId: 'x', modelId: 'm' })),
  ).toThrow('unsupported_schema');
});
