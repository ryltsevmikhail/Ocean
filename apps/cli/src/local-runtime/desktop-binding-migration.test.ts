import { omitModelConnectionSchema } from '../../../../packages/store-sqlite/test-fixtures/model-schema.js';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const a = await original<typeof fs>();
  return {
    ...a,
    fstatSync: vi.fn(a.fstatSync),
    lstatSync: vi.fn(a.lstatSync),
    statSync: vi.fn(a.statSync),
    statfsSync: vi.fn(a.statfsSync),
    readFileSync: vi.fn(a.readFileSync),
  };
});
vi.mock('node:child_process', async (original) => {
  const a = await original<typeof cp>();
  return { ...a, spawnSync: vi.fn(a.spawnSync) };
});
import {
  desktopBootSimulation,
  simulateDesktopFilesystem,
} from '../../../../packages/tools-node/test-fixtures/desktop-boot.test.js';
import { DesktopAssetService } from '@runnets/application';
import { openSqliteStore, readDesktopBackupInventory } from '@runnets/store-sqlite';
import { desktopAssetFiles, desktopRootIdentity } from '@runnets/tools-node';
import { createRuntime } from '../runtime.js';
import { backupProfile } from '../ocean/snapshots.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const boot = await desktopBootSimulation();
  const root = fs.mkdtempSync(join(tmpdir(), 'desktop-upgrade-'));
  roots.push(root);
  const profile = join(root, 'profile'),
    userData = join(root, 'userData');
  for (const path of [profile, userData, join(root, 'home')]) fs.mkdirSync(path, { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const path = join(profile, 'runtime.sqlite'),
    store = openSqliteStore({ path });
  const files = desktopAssetFiles(profile, createHash('sha256').update(profile).digest('hex'));
  new DesktopAssetService(store.desktopAssets, files).enroll(userData);
  const legacy = {
    ...store.desktopAssets.binding()!,
    identity: desktopRootIdentity(store.desktopAssets.binding()!.root),
  };
  store.desktopAssets.start('prepare:room:12345678-1234-4123-8123-123456789abc', '{}');
  store.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding'").run(
    JSON.stringify(legacy),
  );
  db.prepare("UPDATE ocean_desktop_operations SET result=? WHERE id='enrollment'").run(
    JSON.stringify(legacy),
  );
  db.close();
  fs.chmodSync(path, 0o600);
  return { boot, root, profile, path, legacy, before: readDesktopBackupInventory(path) };
}
it('upgrades an exact ordinary legacy binding only at owner startup, preserving enrollment and unknown outcomes', async () => {
  const f = await fixture();
  expect(readDesktopBackupInventory(f.path).binding).toEqual(f.legacy);
  let runtime = createRuntime({ dbPath: f.path });
  await runtime.ready;
  runtime.close();
  const upgraded = readDesktopBackupInventory(f.path);
  expect(upgraded.binding!.identity).toMatch(/^linux-btrfs-v1:/);
  expect(upgraded.operations).toEqual(f.before.operations);
  f.boot.reboot();
  runtime = createRuntime({ dbPath: f.path });
  await runtime.ready;
  runtime.close();
  expect(readDesktopBackupInventory(f.path)).toEqual(upgraded);
});
it('upgrades before the frozen backup while keeping historical operations unchanged', async () => {
  const f = await fixture();
  const archive = join(f.root, 'archive');
  await backupProfile(f.profile, archive);
  const source = readDesktopBackupInventory(f.path),
    snapshot = readDesktopBackupInventory(join(archive, 'runtime.sqlite'));
  expect(source.binding!.identity).toMatch(/^linux-btrfs-v1:/);
  expect(snapshot).toEqual(source);
  expect(source.operations).toEqual(f.before.operations);
});
it.each(['drift', 'invalid-evidence', 'missing-root'])(
  'refuses %s without seeding authority or altering operation outcomes',
  async (kind) => {
    const f = await fixture();
    if (kind === 'drift') f.boot.reboot();
    if (kind === 'invalid-evidence')
      fs.writeFileSync(join(f.legacy.root, 'private.env'), 'synthetic', { mode: 0o600 });
    if (kind === 'missing-root') fs.rmSync(f.legacy.root, { recursive: true });
    await expect(
      (async () => {
        const runtime = createRuntime({ dbPath: f.path });
        try {
          await runtime.ready;
        } finally {
          runtime.close();
        }
      })(),
    ).rejects.toThrow();
    expect(readDesktopBackupInventory(f.path)).toEqual(f.before);
  },
);
it('publishes the current schema with the first anchored backup of an RC2 schema-18 profile', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  omitModelConnectionSchema(db);
  db.exec("UPDATE meta SET value='18' WHERE key='schema_version'");
  db.close();
  const manifest = await backupProfile(f.profile, join(f.root, 'archive18'));
  expect(manifest.summary.schema).toBe(29);
  const source = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(
      source.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    ).toBe('29');
  } finally {
    source.close();
  }
  expect(readDesktopBackupInventory(f.path).binding!.identity).toMatch(/^linux-btrfs-v1:/);
  expect(readDesktopBackupInventory(f.path).operations).toEqual(f.before.operations);
});
it.each([15, 16, 17, 18])(
  'restores source-deleted format-2 schema %s evidence forward without anchoring its archived root',
  async (version) => {
    const f = await fixture();
    const db = new DatabaseSync(f.path);
    omitModelConnectionSchema(db);
    if (version < 18) db.exec('DROP TABLE ocean_plugin_operations');
    if (version < 17)
      for (const table of ['versions', 'connections', 'consents', 'grants', 'confirmations'])
        db.exec('DROP TABLE ocean_plugin_' + table);
    if (version < 16) db.exec('DROP TABLE ocean_broadcast_batches');
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
    db.close();
    await simulateDesktopFilesystem(0x1021994);
    const archive = join(f.root, 'old-archive');
    const manifest = await backupProfile(f.profile, archive);
    expect(manifest.summary.schema).toBe(version);
    fs.rmSync(f.profile, { recursive: true });
    const restored = join(f.root, 'restored');
    const { restoreProfile } = await import('../ocean/snapshots.js');
    expect(restoreProfile(archive, restored)).toEqual(manifest);
    const runtime = createRuntime({
      dbPath: join(restored, 'runtime.sqlite'),
      restoredAccess: true,
    });
    try {
      await runtime.ready;
      expect(runtime.desktopAssets!.binding()).toEqual(f.legacy);
    } finally {
      runtime.close();
    }
  },
);

it('leaves failed new enrollment unknown when the Btrfs helper is unavailable', async () => {
  const f = await fixture(),
    profile = join(f.root, 'new-profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  try {
    const service = new DesktopAssetService(
      store.desktopAssets,
      desktopAssetFiles(profile, createHash('sha256').update(profile).digest('hex')),
    );
    vi.mocked(cp.spawnSync).mockReturnValue({
      error: Error('ENOENT'),
      status: null,
      stdout: '',
      stderr: '',
    } as ReturnType<typeof cp.spawnSync>);
    expect(() => service.enroll(join(f.root, 'userData'))).toThrow('desktop_anchor_unavailable');
    expect(store.desktopAssets.binding()).toBeNull();
    expect(store.desktopAssets.operation('enrollment')).toMatchObject({
      state: 'started',
      result: null,
    });
    expect(() => service.enroll(join(f.root, 'userData'))).toThrow('desktop_outcome_unknown');
  } finally {
    store.close();
  }
});
