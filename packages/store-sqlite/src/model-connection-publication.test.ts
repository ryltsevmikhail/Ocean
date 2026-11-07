import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  ModelConnectionService,
  type ModelCredentialFactory,
  type ModelConnectionSetInput,
} from '@runnets/application';
import { initializeSchema } from './schema.js';
import { SqliteModelConnections } from './model-connection-storage.js';
import { InMemoryConversationStore } from '@runnets/store';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const input: ModelConnectionSetInput = {
  connectionId: 'local',
  requestId: 'set',
  expectedRevision: null,
  providerId: 'fixture',
  kind: 'local',
  endpoint: 'http://127.0.0.1:8080',
  auth: 'none',
  defaultModelId: 'model',
};
function setup() {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  const store = new SqliteModelConnections(db);
  const factory: ModelCredentialFactory = {
    catalog: () => [
      {
        modelId: 'model',
        capabilities: {
          tools: false,
          streaming: true,
          inputModalities: ['text'],
          contextTokens: null,
          maxOutputTokens: null,
          usage: 'unavailable',
        },
      },
    ],
    external: () => {
      throw Error('unexpected_external');
    },
    activate: () => ({
      source: 'auth_none',
      provider: {
        id: 'fixture',
        models: ['model'],
        capabilities: { streaming: true, reasoning: false, usage: false },
        async *stream() {
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      },
      check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['model'] }),
    }),
  };
  const secrets = {
    read: () => {
      throw Error('unexpected_secret');
    },
    write: () => {
      throw Error('unexpected_secret');
    },
    replace: () => {
      throw Error('unexpected_secret');
    },
    remove: () => {
      throw Error('unexpected_secret');
    },
  };
  const service = new ModelConnectionService({
    store,
    factory,
    secrets,
    clock: { now: () => new Date('2026-11-04T00:00:00Z') },
    nextId: () => 'id',
    sha256: (s) => s,
  });
  return { db, store, service, factory };
}
it('roundtrips exact public receipt snapshots in both stores and shares namespace with legacy receipts', () => {
  const c = setup();
  const status = c.service.set(input);
  const receipt = c.store.receipt('set')!;
  expect(receipt.publicResult).toEqual({ version: 1, status });
  c.service.disconnect({ connectionId: 'local', requestId: 'off', expectedRevision: 1 });
  c.factory.catalog = () => [];
  expect(c.service.set(input)).toEqual(status);
  const memory = new InMemoryConversationStore();
  memory.activate(receipt.result, null, { requestId: 'set', value: receipt });
  expect(memory.receipt('set')).toEqual(receipt);
  expect(() => c.store.legacyReceipt('set')).toThrow('request_conflict');
  expect(JSON.stringify(status)).not.toMatch(/secretRef|pendingSecretChange|binding/);
});
it('atomically rolls back canonical activation and the public receipt when receipt storage rejects', () => {
  const c = setup();
  c.db.exec(
    "CREATE TRIGGER reject_public BEFORE INSERT ON ocean_model_connection_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  expect(() => c.service.set(input)).toThrow('receipt failure');
  expect(c.store.read('local')).toBeNull();
  expect(c.store.receipt('set')).toBeNull();
});
it('CAS is scoped to the chosen connection even when a sibling has the requested revision', () => {
  const c = setup();
  c.service.set(input);
  c.service.set({ ...input, connectionId: 'sibling', requestId: 'sibling' });
  c.service.disconnect({ connectionId: 'local', requestId: 'off', expectedRevision: 1 });
  expect(() => c.service.set({ ...input, requestId: 'stale', expectedRevision: 1 })).toThrow(
    'revision_conflict',
  );
  expect(c.store.read('sibling')!.revision).toBe(1);
  expect(c.store.read('local')!.revision).toBe(2);
});
it.each(['source', 'state', 'auth', 'kind'])(
  'rejects non-scalar public result %s on persisted receipt reads',
  (field) => {
    const c = setup();
    c.service.set(input);
    const row = c.db
      .prepare('SELECT result FROM ocean_model_connection_receipts WHERE request_id=?')
      .get('set')!;
    const payload = JSON.parse(row['result'] as string) as {
      publicResult: { status: Record<string, unknown> };
    };
    payload.publicResult.status[field] = [payload.publicResult.status[field]];
    c.db
      .prepare('UPDATE ocean_model_connection_receipts SET result=? WHERE request_id=?')
      .run(JSON.stringify(payload), 'set');
    expect(() => c.service.set(input)).toThrow('connection_unverified');
  },
);
it('refuses historical internal-only receipts without reinterpreting a current catalog', () => {
  const c = setup();
  c.service.set(input);
  const receipt = c.store.receipt('set')!;
  c.db
    .prepare('UPDATE ocean_model_connection_receipts SET result=? WHERE request_id=?')
    .run(JSON.stringify(receipt.result), 'set');
  c.factory.catalog = () => {
    throw Error('unexpected_catalog');
  };
  expect(() => c.service.set(input)).toThrow('receipt_result_unavailable');
});
