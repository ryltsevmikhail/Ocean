import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { unconfiguredModelConnection, type ModelConnectionRecord } from '@runnets/application';
import { initializeSchema } from './schema.js';
import { SqliteModelConnections } from './model-connection-storage.js';
import { SqliteProviderConnections } from './provider-connection-storage.js';
import { InMemoryConversationStore } from '@runnets/store';
import { malformedModelEnums, modelEnumRecord } from '../test-fixtures/model-enum-payloads.js';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function setup() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  opened.push(db);
  initializeSchema(db);
  return { db, models: new SqliteModelConnections(db), legacy: new SqliteProviderConnections(db) };
}
const record: ModelConnectionRecord = {
  ...unconfiguredModelConnection('deepseek'),
  intent: 'active',
  revision: 1,
  legacyEnvironment: true,
  defaultModelId: 'one',
  secretRef: 'opaque-ref',
};
const legacyRecord = {
  provider: 'deepseek',
  model: 'one',
  secretRef: 'opaque-ref',
  intent: 'active' as const,
  revision: 1,
  requestId: 'old',
  binding: 'legacy-fingerprint',
  lastCheck: null,
  updatedAt: 'then',
};
const legacyReceipt = {
  binding: 'legacy-fingerprint',
  result: {
    provider: 'deepseek',
    source: 'saved' as const,
    state: 'connected' as const,
    model: 'one',
    models: ['one'],
    modelCapabilities: [],
    revision: 1,
    savedKey: true,
    writable: true,
    code: null,
    lastCheck: null,
  },
};

it('keeps one metadata authority across both API generations and projects placeholder CAS as null', () => {
  const { db, models, legacy } = setup();
  expect(models.read('legacy:deepseek')).toMatchObject({ revision: 0, intent: 'unconfigured' });
  expect(legacy.read('deepseek')).toBeNull();
  legacy.put(legacyRecord, null);
  expect(models.read('legacy:deepseek')).toMatchObject({
    revision: 1,
    defaultModelId: 'one',
    legacyEnvironment: true,
  });
  models.put({ ...record, revision: 2, defaultModelId: 'two', intent: 'disconnected' }, 1);
  expect(legacy.read('deepseek')).toMatchObject({
    revision: 2,
    model: 'two',
    intent: 'disconnected',
  });
  expect(() => legacy.put(legacyRecord, 1)).toThrow('revision_conflict');
  expect(db.prepare('SELECT * FROM ocean_provider_connections').all()).toEqual([]);
  expect(models.list()).toEqual([models.read('legacy:deepseek')]);
});

it('preserves exact legacy fingerprint/result bytes and replays them before reading current state', () => {
  const { db, models, legacy } = setup();
  const bytes = ' \n' + JSON.stringify(legacyReceipt, null, 2) + '\n ';
  db.prepare('INSERT INTO ocean_provider_receipts VALUES(?,?,?,?)').run(
    'historic',
    'deepseek',
    'legacy-fingerprint',
    bytes,
  );
  models.put(record, 0);
  models.put({ ...record, revision: 2, defaultModelId: 'two' }, 1);
  db.prepare('UPDATE ocean_model_connections SET payload=?').run('invalid-json');
  expect(legacy.receipt('historic')).toEqual(legacyReceipt);
  expect(() => models.receipt('historic')).toThrow('request_conflict');
  expect(
    db.prepare('SELECT result FROM ocean_provider_receipts WHERE request_id=?').get('historic')?.[
      'result'
    ],
  ).toBe(bytes);
});

it('rejects request IDs from either receipt namespace atomically in both directions', () => {
  const { models, legacy } = setup();
  legacy.activate(legacyRecord, null, { requestId: 'legacy-id', value: legacyReceipt });
  const two = { ...record, revision: 2 };
  expect(() =>
    models.activate(two, 1, { requestId: 'legacy-id', value: { binding: 'new', result: two } }),
  ).toThrow('request_conflict');
  expect(models.read(record.connectionId)?.revision).toBe(1);
  models.activate(two, 1, { requestId: 'v2-id', value: { binding: 'new', result: two } });
  expect(() =>
    legacy.activate({ ...legacyRecord, revision: 3 }, 2, {
      requestId: 'v2-id',
      value: legacyReceipt,
    }),
  ).toThrow('request_conflict');
  expect(() => legacy.receipt('v2-id')).toThrow('request_conflict');
  expect(models.read(record.connectionId)?.revision).toBe(2);
  models.put({ ...two, revision: 3, defaultModelId: 'later' }, 2);
  expect(models.receipt('v2-id')).toEqual({ binding: 'new', result: two });
  expect(legacy.receipt('legacy-id')).toEqual(legacyReceipt);
});

it('rolls back canonical activation when receipt publication fails', () => {
  const { db, models } = setup();
  db.exec(
    "CREATE TRIGGER reject_model_receipt BEFORE INSERT ON ocean_model_connection_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  expect(() =>
    models.activate(record, 0, { requestId: 'new', value: { binding: 'new', result: record } }),
  ).toThrow('receipt failure');
  expect(models.read(record.connectionId)?.revision).toBe(0);
  expect(models.receipt('new')).toBeNull();
});

it.each([
  { intent: 'unconfigured', revision: 1 },
  { intent: 'active', revision: 0 },
  { legacyEnvironment: 'yes' },
  { kind: 'maybe' },
  { auth: 'unknown' },
  { configuredAfterRestore: 'yes' },
  { pendingSecretChange: { action: 'rotate', previousRef: null, nextRef: null } },
  { lastCheck: { outcome: 'ok' } },
  { endpoint: 42 },
  { defaultModelId: undefined },
])('refuses malformed canonical fields on every read: %j', (patch) => {
  const { db, models, legacy } = setup();
  db.prepare('UPDATE ocean_model_connections SET payload=?').run(
    JSON.stringify({ ...record, ...patch }),
  );
  expect(() => models.read(record.connectionId)).toThrow('connection_unverified');
  expect(() => models.list()).toThrow('connection_unverified');
  expect(() => legacy.read('deepseek')).toThrow('connection_unverified');
});

it('validates identity columns and receipt snapshots rather than trusting JSON casts', () => {
  const { db, models } = setup();
  db.prepare('UPDATE ocean_model_connections SET payload=?').run(
    JSON.stringify({ ...record, connectionId: 'wrong' }),
  );
  expect(() => models.read(record.connectionId)).toThrow('connection_unverified');
  db.prepare('UPDATE ocean_model_connections SET payload=?').run(JSON.stringify(record));
  db.prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)').run(
    'bad',
    record.connectionId,
    'b',
    '{}',
  );
  expect(() => models.receipt('bad')).toThrow('connection_unverified');
  expect(() => models.put({ ...record, revision: 0 }, 1)).toThrow('connection_unverified');
});

it.each(malformedModelEnums)(
  'rejects $label in canonical reads and receipt decoding',
  ({ payload }) => {
    const { db, models } = setup();
    db.prepare('UPDATE ocean_model_connections SET payload=?').run(payload);
    expect(() => models.read(record.connectionId)).toThrow('connection_unverified');
    expect(() => models.list()).toThrow('connection_unverified');
    db.prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)').run(
      'malformed-enum',
      record.connectionId,
      'digest',
      payload,
    );
    expect(() => models.receipt('malformed-enum')).toThrow('connection_unverified');
  },
);

it.each(malformedModelEnums)(
  'rejects $label in both adapters before connection or receipt writes',
  ({ payload }) => {
    const { models } = setup();
    const malformed = JSON.parse(payload) as ModelConnectionRecord;
    for (const store of [models, new InMemoryConversationStore()]) {
      const before = store.read(record.connectionId);
      expect(() => store.put(malformed, 0)).toThrow('connection_unverified');
      expect(() =>
        store.activate(malformed, 0, {
          requestId: 'malformed-enum',
          value: { binding: 'digest', result: malformed },
        }),
      ).toThrow('connection_unverified');
      expect(() =>
        store.activate(modelEnumRecord, 0, {
          requestId: 'malformed-snapshot',
          value: { binding: 'digest', result: malformed },
        }),
      ).toThrow('connection_unverified');
      expect(() =>
        store.activate(malformed, 0, {
          requestId: 'malformed-record',
          value: { binding: 'digest', result: modelEnumRecord },
        }),
      ).toThrow('connection_unverified');
      expect(store.read(record.connectionId)).toEqual(before);
      expect(store.receipt('malformed-enum')).toBeNull();
      expect(store.receipt('malformed-snapshot')).toBeNull();
      expect(store.receipt('malformed-record')).toBeNull();
    }
  },
);
