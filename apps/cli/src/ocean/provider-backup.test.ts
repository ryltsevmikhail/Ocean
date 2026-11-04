import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderConnectionService } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createProviderSecretStore } from '@runnets/tools-node';
import { openOceanProfile } from './profile.js';
import { backupProfile, restoreProfile } from './snapshots.js';
import { createProviderCredentials } from '../local-runtime/provider-settings.js';
import { restoreMarkerPresent } from '../runtime-restoration.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const KEY = 'sk-fixture-backup-provider-key';
function files(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const relative = prefix + '/' + entry;
      if (statSync(path).isDirectory()) walk(path, relative);
      else out.push(relative);
    }
  };
  walk(root, '');
  return out;
}
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
async function connection(profile: string) {
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  if (!runtime.providerConnections) throw Error('durable profile expected');
  const service = new ProviderConnectionService({
    store: runtime.providerConnections,
    secrets: createProviderSecretStore(profile + '.credentials'),
    credentials: createProviderCredentials({ env: {} }),
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => randomUUID().replaceAll('-', ''),
    sha256,
  });
  service.initialize();
  return { service, close: () => runtime.close() };
}

it('backs up provider metadata but no credential path or bytes, and restores inert', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-provider-backup-'));
  roots.push(root);
  const profile = join(root, 'profile');
  const saved = await connection(profile);
  expect(
    saved.service.set({ requestId: 'set-1', key: KEY, model: 'deepseek-flash' }),
  ).toMatchObject({ source: 'saved', state: 'connected', revision: 1 });
  saved.close();
  const credentialFile = join(profile + '.credentials', 'providers.json');
  expect(readFileSync(credentialFile, 'utf8')).toContain(KEY);

  const archive = join(root, 'backup');
  const manifest = await backupProfile(profile, archive, {
    managedDirectory: join(root, 'worktrees'),
  });
  expect(manifest.format).toBe(2);
  const archived = files(archive);
  expect(archived.some((path) => path.includes('.credentials'))).toBe(false);
  expect(archived.some((path) => path.includes('providers.json'))).toBe(false);
  for (const relative of archived) {
    const bytes = readFileSync(join(archive, relative));
    expect(bytes.includes(Buffer.from(KEY))).toBe(false);
  }
  const manifestText = JSON.stringify(manifest);
  expect(manifestText).not.toContain(KEY);
  expect(manifestText).not.toContain('.credentials');

  // The live credential stays outside the profile and survives the backup untouched.
  expect(statSync(profile + '.credentials').mode & 0o777).toBe(0o700);
  expect(readFileSync(credentialFile, 'utf8')).toContain(KEY);

  // Metadata is in the backup, so the restored profile knows a saved connection existed.
  const restoredDirectory = join(root, 'quarantine');
  expect(restoreProfile(archive, restoredDirectory)).toEqual(manifest);
  expect(restoreMarkerPresent(restoredDirectory)).toBe(true);
  const restored = openSqliteStore({ path: join(restoredDirectory, 'runtime.sqlite') });
  try {
    expect(restored.providerConnections.read('deepseek')).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      intent: 'active',
      secretRef: expect.stringMatching(/^psec_/),
    });
  } finally {
    restored.close();
  }
  // The backup excluded the credential directory, so this restored profile has no secret bytes.
  const restoredBytes = files(restoredDirectory).map((path) =>
    readFileSync(join(restoredDirectory, path)),
  );
  expect(restoredBytes.some((bytes) => bytes.includes(Buffer.from(KEY)))).toBe(false);

  // A maintenance host on the restored profile reports the inert state and never activates the
  // saved metadata or the environment automatically.
  const restoredService = new ProviderConnectionService({
    store: new (class {
      readonly #path = join(restoredDirectory, 'runtime.sqlite');
      read(provider: string) {
        const store = openSqliteStore({ path: this.#path });
        try {
          return store.providerConnections.read(provider);
        } finally {
          store.close();
        }
      }
      put(): void {
        throw Error('restored');
      }
      activate(): void {
        throw Error('restored');
      }
      receipt() {
        return null;
      }
    })(),
    secrets: createProviderSecretStore(restoredDirectory + '.credentials'),
    credentials: createProviderCredentials({
      env: { DEEPSEEK_API_KEY: 'sk-fixture-environment-key' },
    }),
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => randomUUID().replaceAll('-', ''),
    sha256,
    restored: restoreMarkerPresent(restoredDirectory),
    mutationsAllowed: false,
  });
  restoredService.initialize();
  expect(restoredService.status()).toMatchObject({
    source: 'none',
    state: 'restored',
    savedKey: true,
    writable: false,
  });
  expect(restoredService.current()).toBeNull();
}, 60_000);
