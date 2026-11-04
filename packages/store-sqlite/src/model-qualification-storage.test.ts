import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { unconfiguredModelConnection, type ModelConnectionRecord } from '@runnets/application';
import { InMemoryConversationStore } from '@runnets/store';
import { initializeSchema, SCHEMA_VERSION } from './schema.js';
import { SqliteModelConnections } from './model-connection-storage.js';
const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function setup() {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  return { db, store: new SqliteModelConnections(db) };
}
const qualification = {
  modelId: 'qwen3:1.7b',
  artifactDigest: 'a'.repeat(64),
  backendVersion: 'fixture',
  configuredContextTokens: 4096,
  capabilities: {
    tools: true,
    streaming: true,
    inputModalities: ['text'] as const,
    contextTokens: 4096,
    maxOutputTokens: null,
    usage: 'optional' as const,
  },
};
const record: ModelConnectionRecord = {
  ...unconfiguredModelConnection('ollama'),
  connectionId: 'local',
  providerId: 'ollama',
  kind: 'local',
  auth: 'none',
  endpoint: 'http://127.0.0.1:11434',
  defaultModelId: 'qwen3:1.7b',
  intent: 'active',
  revision: 1,
  legacyEnvironment: false,
  localQualification: null,
};
it('migrates previous payloads to explicit null without changing frozen receipt bytes', () => {
  const { db, store } = setup();
  const { localQualification: _old, ...old } = record;
  db.prepare('INSERT INTO ocean_model_connections VALUES(?,?)').run('local', JSON.stringify(old));
  const receipt = ' ' + JSON.stringify(old) + '\n';
  db.prepare('INSERT INTO ocean_model_connection_receipts VALUES(?,?,?,?)').run(
    'old',
    'local',
    'binding',
    receipt,
  );
  db.exec("UPDATE meta SET value='20' WHERE key='schema_version'");
  initializeSchema(db);
  expect(SCHEMA_VERSION).toBe(21);
  expect(store.read('local')?.localQualification).toBeNull();
  expect(
    JSON.parse(
      String(
        db
          .prepare("SELECT payload FROM ocean_model_connections WHERE connection_id='local'")
          .get()?.['payload'],
      ),
    ),
  ).toHaveProperty('localQualification', null);
  expect(
    db.prepare("SELECT result FROM ocean_model_connection_receipts WHERE request_id='old'").get()?.[
      'result'
    ],
  ).toBe(receipt);
  expect(store.receipt('old')?.result.localQualification).toBeNull();
});
it('publishes evidence and revision as one CAS payload in memory and SQLite', () => {
  const { db, store } = setup();
  for (const s of [store, new InMemoryConversationStore()]) {
    s.put(record, null);
    s.put({ ...record, revision: 2, localQualification: qualification }, 1);
    expect(() =>
      s.put(
        {
          ...record,
          revision: 3,
          localQualification: { ...qualification, backendVersion: 'stale' },
        },
        1,
      ),
    ).toThrow('revision_conflict');
    expect(s.read('local')).toMatchObject({ revision: 2, localQualification: qualification });
    const read = s.read('local')!;
    Object.assign(read.localQualification!, { backendVersion: 'mutated' });
    expect(s.read('local')?.localQualification?.backendVersion).toBe('fixture');
  }
  expect(new SqliteModelConnections(db).read('local')?.localQualification).toEqual(qualification);
  db.exec(
    "CREATE TRIGGER reject_qual BEFORE UPDATE ON ocean_model_connections BEGIN SELECT RAISE(ABORT,'failure'); END",
  );
  expect(() => store.put({ ...record, revision: 3, localQualification: qualification }, 2)).toThrow(
    'failure',
  );
  expect(store.read('local')?.revision).toBe(2);
});
it.each([
  { artifactDigest: 'short' },
  { configuredContextTokens: 8192 },
  { modelId: 'wrong' },
  { capabilities: { tools: true } },
])('refuses malformed present evidence %j', (patch) => {
  const { store } = setup();
  expect(() =>
    store.put(
      { ...record, localQualification: { ...qualification, ...patch } } as ModelConnectionRecord,
      null,
    ),
  ).toThrow('connection_unverified');
  expect(store.read('local')).toBeNull();
});
it('refuses qualification on a cloud row, preserving historical missing fields as null', () => {
  const { db, store } = setup();
  expect(() =>
    store.put(
      { ...record, kind: 'cloud', auth: 'api_key', localQualification: qualification },
      null,
    ),
  ).toThrow('connection_unverified');
  db.prepare(
    "UPDATE ocean_model_connections SET payload=json_remove(payload,'$.localQualification') WHERE connection_id='legacy:deepseek'",
  ).run();
  expect(store.read('legacy:deepseek')?.localQualification).toBeNull();
});
it('survives a file-backed close/reopen with exact qualification and frozen receipt', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qualification-')),
    file = join(folder, 'fixture.sqlite');
  const db = new DatabaseSync(file);
  initializeSchema(db);
  const store = new SqliteModelConnections(db);
  store.activate(record, null, { requestId: 'set', value: { binding: 'owner', result: record } });
  const before = db
    .prepare("SELECT result FROM ocean_model_connection_receipts WHERE request_id='set'")
    .get()?.['result'];
  store.put({ ...record, revision: 2, localQualification: qualification }, 1);
  db.close();
  const reopened = new DatabaseSync(file);
  opened.push(reopened);
  initializeSchema(reopened);
  expect(new SqliteModelConnections(reopened).read('local')).toEqual({
    ...record,
    revision: 2,
    localQualification: qualification,
  });
  expect(
    reopened
      .prepare("SELECT result FROM ocean_model_connection_receipts WHERE request_id='set'")
      .get()?.['result'],
  ).toBe(before);
  expect(new SqliteModelConnections(reopened).receipt('set')?.result.localQualification).toBeNull();
});
