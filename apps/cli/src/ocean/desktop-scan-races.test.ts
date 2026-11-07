/* Test-only scanner boundary injection; traversal stays real. */
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfileRebindService, RuntimeOwnerDecisions } from '@runnets/application';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import * as source from '../../../../packages/tools-node/src/coding-asset-source.js';
import { desktopBootSimulation } from '../../../../packages/tools-node/test-fixtures/desktop-boot.test.js';
import { codingDesktopFixture } from './desktop-workflow-fixture.js';
import { backupProfile, restoreProfile } from './snapshots.js';

vi.mock('node:fs', async (original) => {
  const a = await original<typeof fs>();
  return {
    ...a,
    fstatSync: vi.fn(a.fstatSync),
    lstatSync: vi.fn(a.lstatSync),
    statSync: vi.fn(a.statSync),
    statfsSync: vi.fn(a.statfsSync),
    readFileSync: vi.fn(a.readFileSync),
    readSync: vi.fn(a.readSync),
  };
});
vi.mock('node:child_process', async (original) => {
  const a = await original<typeof cp>();
  return { ...a, spawnSync: vi.fn(a.spawnSync) };
});
vi.mock('../../../../packages/tools-node/src/coding-asset-source.js', async (original) => {
  const a = await original<typeof source>();
  return { ...a, scanAssetSource: vi.fn(a.scanAssetSource) };
});

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function readyDesktop() {
  const actual = await vi.importActual<typeof fs>('node:fs');
  const scanner = await vi.importActual<typeof source>(
    '../../../../packages/tools-node/src/coding-asset-source.js',
  );
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.mocked(source.scanAssetSource).mockImplementation(scanner.scanAssetSource);
  await desktopBootSimulation();
  const root = fs.mkdtempSync(join(tmpdir(), 'desktop-scan-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await codingDesktopFixture();
  cleanups.push(f.close);
  const selected = join(root, 'project');
  cp.execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const archive = join(root, 'archive');
  await backupProfile(f.directory, archive, {
    managedDirectory: join(f.directory, 'worktrees'),
  });
  fs.rmSync(f.directory, { recursive: true });
  const profile = join(root, 'profile');
  restoreProfile(archive, profile);
  fs.rmSync(archive, { recursive: true });
  const store = stores.openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  cleanups.push(() => store.close());
  const origin = store.restoration.origin()!;
  const task = store.coding.atomic((tx) => tx.task(f.task.id))!;
  const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
  const files = new adapters.RestoredProfileFiles(profile, stores.readProfileRestoreSnapshot);
  const service = new ProfileRebindService({
    store: store.rebind,
    files,
    owner,
    leases: new adapters.SqliteProjectLeases(),
    now: Date.now,
    nextId: randomUUID,
    digest: (value) => createHash('sha256').update(value).digest('hex'),
  });
  cleanups.push(() => service.close());
  const selection = {
    requestId: 'scan-race',
    workspaceId: task.workspaceId,
    roomId: f.room,
    profileId: origin.profileId,
    snapshotId: origin.snapshotId,
    sourceOwnerId: task.lease.ownerId,
    taskId: task.id,
    projectRoot: selected,
    baseCommit: task.baseCommit,
    treeHash: await new adapters.GitCodingApplyProject().tree(selected, task.baseCommit),
    policy: task.policy,
  };
  const card = await service.preview(selection);
  await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
  await service.join();
  const record = service.result(selection);
  expect(record.state, record.reason ?? '').toBe('ready');
  expect(record.result!.desktop!.identity).toMatch(/^linux-btrfs-v1:/);
  return { actual, scanner, profile, store, files, record };
}

it.each(['capture', 'ready lineage', 'rebind verification'] as const)(
  'refuses a root replaced before the first %s scan without reading replacement bodies',
  async (consumer) => {
    const { actual, scanner, profile, store, files, record } = await readyDesktop();
    const binding = record.result!.desktop!;
    const operation = async () => {
      if (consumer === 'capture')
        return adapters.captureDesktopAssets(store.desktopAssets.inventory(false));
      if (consumer === 'ready lineage') return adapters.inspectLineageIntent(profile, record);
      return files.verify(record.preview, record.result!);
    };
    // Every variant first succeeds with the real ready record, archive and filesystem.
    await operation();
    let replaced = false,
      replacementBodyReads = 0;
    vi.mocked(source.scanAssetSource).mockImplementation((...args) => {
      if (!replaced && args[0] === binding.root) {
        // The consumer has validated its root; replace it at the first scan entry.
        replaced = true;
        actual.renameSync(binding.root, binding.root + '-original');
        actual.cpSync(binding.root + '-original', binding.root, { recursive: true });
        actual.chmodSync(binding.root, 0o700);
      }
      return scanner.scanAssetSource(...args);
    });
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(binding.root + '/'))
        replacementBodyReads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    await expect(operation()).rejects.toThrow('stale_coding_asset');
    expect(replaced).toBe(true);
    expect(replacementBodyReads).toBe(0);
    expect(store.rebind.active()).toEqual(record);
  },
  120000,
);
