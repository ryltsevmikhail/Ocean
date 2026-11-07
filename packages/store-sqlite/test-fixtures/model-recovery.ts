/* eslint-disable no-restricted-imports -- Same-package storage composition fixture. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  ModelConnectionService,
  type ModelCredentialFactory,
  type ProviderSecretStorePort,
} from '@runnets/application';
import { createProviderSecretStore } from '@runnets/tools-node';
import { initializeSchema } from '../src/schema.js';
import { SqliteModelConnections } from '../src/model-connection-storage.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
export function modelRecovery() {
  const root = mkdtempSync(join(tmpdir(), 'model-recovery-'));
  const path = join(root, 'runtime.sqlite');
  const privateStore = createProviderSecretStore(join(root, 'credentials'));
  const calls: string[] = [];
  const controls: { fail: 'remove' | 'replace' | 'write' | null } = { fail: null };
  const secrets: ProviderSecretStorePort = {
    read(ref) {
      calls.push('read');
      return privateStore.read(ref);
    },
    write(ref, key) {
      calls.push('write');
      if (controls.fail === 'write') throw Error('synthetic disk failure');
      privateStore.write(ref, key);
    },
    replace(previous, next, key) {
      calls.push('replace');
      if (controls.fail === 'replace') throw Error('synthetic disk failure');
      privateStore.replace(previous, next, key);
    },
    remove(ref) {
      calls.push('remove');
      if (controls.fail === 'remove') throw Error('synthetic disk failure');
      privateStore.remove(ref);
    },
  };
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
    external: () => null,
    activate: (_descriptor, secret) =>
      secret?.status === 'ok'
        ? {
            source: 'saved',
            provider: {
              id: 'fixture',
              models: ['model'],
              capabilities: { streaming: true, reasoning: false, usage: false },
              async *stream() {
                yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
              },
            },
            check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['model'] }),
          }
        : null,
  };
  let ids = 0;
  let db = new DatabaseSync(path);
  initializeSchema(db);
  let store = new SqliteModelConnections(db);
  const build = () =>
    new ModelConnectionService({
      store,
      factory,
      secrets,
      clock: { now: () => new Date('2026-11-04T00:00:00Z') },
      nextId: () => String(++ids).padStart(32, '0'),
      sha256: (s) => createHash('sha256').update(s).digest('hex'),
    });
  let service = build();
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    controls,
    calls,
    privateStore,
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      initializeSchema(db);
      store = new SqliteModelConnections(db);
      service = build();
    },
  };
}
