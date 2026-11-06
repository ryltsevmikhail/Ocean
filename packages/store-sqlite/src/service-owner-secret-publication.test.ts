import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ServiceOwnerSettings } from '@runnets/application';
import { createProviderSecretStore } from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
import { SqliteServiceAuthority } from './service-authority-storage.js';
import { initializeSchema } from './schema.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const providerRef = 'psec_' + 'p'.repeat(32),
  providerKey = 'synthetic-unrelated-provider';
const tuple = (c: ServiceConnection) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-private-publication-')),
    path = join(root, 'db'),
    directory = join(root, 'private'),
    file = join(directory, 'providers.json');
  let db = new DatabaseSync(path),
    store: SqliteServiceAuthority,
    service: ServiceOwnerSettings,
    ids = 0;
  const secrets = createProviderSecretStore(directory);
  secrets.write(providerRef, providerKey);
  function reopen() {
    initializeSchema(db);
    store = new SqliteServiceAuthority(db);
    service = new ServiceOwnerSettings({
      store,
      secrets,
      ownerId: 'owner',
      now: Date.now,
      sha256: (v) => createHash('sha256').update(v).digest('hex'),
      nextId: () => String(++ids).padStart(32, 'a'),
      writable: () => true,
      refresh: async () => {
        throw Error('unused');
      },
    });
  }
  reopen();
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const input = {
    requestId: 'initial',
    connectionId: 'service',
    expectedVersions: null,
    name: 'Owned',
    configuration: { kind: 'http' as const, url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none' as const,
    key: 'A',
  };
  const first = service!.setConnection(input).result as ServiceConnection;
  const body = JSON.parse(readFileSync(file, 'utf8')) as {
    version: number;
    secrets: Record<string, { key: string }>;
  };
  let n = 0,
    last = '';
  while (Buffer.byteLength(JSON.stringify(body) + '\n') < 65100) {
    last = 'psec_' + String(++n).padStart(32, 'f');
    body.secrets[last] = { key: 'P'.repeat(512) };
  }
  const bytes = Buffer.byteLength(JSON.stringify(body) + '\n');
  if (bytes > 65400) body.secrets[last]!.key = 'P'.repeat(512 - (bytes - 65400));
  writeFileSync(file, JSON.stringify(body) + '\n');
  return {
    file,
    secrets,
    input,
    first,
    service: () => service!,
    store: () => store!,
    db: () => db,
    restart() {
      db.close();
      db = new DatabaseSync(path);
      reopen();
    },
  };
}
it('near-capacity failed publication keeps provider and old service bytes; explicit recovery replaces only the service entry', () => {
  const f = fixture(),
    before = readFileSync(f.file);
  const request = {
    ...f.input,
    requestId: 'overflow',
    expectedVersions: tuple(f.first),
    key: 'B'.repeat(512),
  };
  expect(() => f.service().setConnection(request)).toThrow('provider_write_failed');
  expect(readFileSync(f.file)).toEqual(before);
  expect(f.secrets.read(providerRef)).toEqual({ status: 'ok', key: providerKey });
  f.restart();
  expect(f.service().setConnection(request)).toMatchObject({ state: 'prepared' });
  expect(readFileSync(f.file)).toEqual(before);
  const done = f.service().setConnection({ ...request, requestId: 'explicit-recovery', key: 'C' });
  expect(done.state).toBe('completed');
  expect(f.secrets.read(f.first.credentialReference!.slice(6))).toEqual({ status: 'absent' });
  expect(f.secrets.read(providerRef)).toEqual({ status: 'ok', key: providerKey });
  expect(f.service().receipt('overflow')).toMatchObject({ state: 'prepared' });
});
it('after atomic replacement and final SQLite failure, restart never retries and explicit resupply preserves unrelated material', () => {
  const f = fixture();
  f.db().exec(
    "CREATE TRIGGER fail_revision BEFORE UPDATE ON ocean_service_connections BEGIN SELECT RAISE(ABORT,'synthetic final commit failure'); END",
  );
  const request = {
    ...f.input,
    requestId: 'interrupted',
    expectedVersions: tuple(f.first),
    key: 'B',
  };
  expect(() => f.service().setConnection(request)).toThrow('synthetic final commit failure');
  expect(f.store().atomic((tx) => tx.connection('service'))).toEqual(f.first);
  expect(f.secrets.read(f.first.credentialReference!.slice(6))).toEqual({ status: 'absent' });
  expect(f.secrets.read(providerRef)).toEqual({ status: 'ok', key: providerKey });
  const published = readFileSync(f.file);
  f.restart();
  expect(f.service().setConnection(request)).toMatchObject({
    state: 'prepared',
    recovery: 'explicit_recovery_required',
  });
  expect(readFileSync(f.file)).toEqual(published);
  f.db().exec('DROP TRIGGER fail_revision');
  expect(
    f.service().setConnection({ ...request, requestId: 'explicit-recovery', key: 'C' }),
  ).toMatchObject({ state: 'completed' });
  expect(f.secrets.read(providerRef)).toEqual({ status: 'ok', key: providerKey });
  expect(f.store().atomic((tx) => tx.listGrants())).toEqual([]);
});
