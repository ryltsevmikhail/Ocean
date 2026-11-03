import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { ProfileRebindService, RuntimeOwnerDecisions } from '@runnets/application';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { createRuntime } from '../runtime.js';
const snapshotHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
it('recovers all ready-tree bytes after the last changeset under a fresh task and Git binding', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'rebind-full-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const f = await codingWorkflowFixture('direct');
  let store: ReturnType<typeof stores.openSqliteStore> | undefined;
  let service: ProfileRebindService | undefined;
  try {
    const selected = join(root, 'new-project');
    execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'old frozen changeset\n');
    const artifact = await f.capture('last-capture');
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'later ready-tree content\n');
    fs.writeFileSync(join(f.worktree, 'binary.bin'), Buffer.from([0, 255, 10, 0]), { mode: 0o755 });
    fs.writeFileSync(join(f.worktree, 'math.cjs'), 'module.exports=(a,b)=>a+b;\n');
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const inventory = stores.readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        {
          id: 'project',
          root: f.project,
          testPresets: inventory.tasks[0]!.policy.testPresets,
          mounts: [],
        },
      ]),
      { mode: 0o600 },
    );
    const archive = join(root, 'archive');
    const firstManifest = await backupProfile(f.directory, archive, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    const firstSnapshotId = snapshotHash(firstManifest);
    fs.rmSync(f.directory, { recursive: true });
    const profile = join(root, 'profile');
    restoreProfile(archive, profile);
    fs.rmSync(archive, { recursive: true });
    store = stores.openSqliteStore({ path: join(profile, 'runtime.sqlite') });
    const origin = store.restoration.origin()!,
      old = store.coding.atomic((tx) => tx.task('task'))!;
    const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
    const files =
      adapters.RestoredProfileFiles &&
      new adapters.RestoredProfileFiles(profile, stores.readProfileRestoreSnapshot);
    expect(files).toBeDefined();
    service = new ProfileRebindService({
      store: store.rebind,
      files: files!,
      owner,
      leases: new adapters.SqliteProjectLeases(),
      now: Date.now,
      nextId: randomUUID,
      digest: (text) => createHash('sha256').update(text).digest('hex'),
    });
    const selection = {
      requestId: 'restore-ready-tree',
      workspaceId: old.workspaceId,
      roomId: old.ownerRoomId,
      profileId: origin.profileId,
      snapshotId: origin.snapshotId,
      sourceOwnerId: old.lease.ownerId,
      taskId: old.id,
      projectRoot: selected,
      baseCommit: old.baseCommit,
      treeHash: await new adapters.GitCodingApplyProject().tree(selected, old.baseCommit),
      policy: old.policy,
    };
    const card = await service.preview(selection);
    expect(card.kind).toBe('restore-rebind');
    expect(fs.readFileSync(join(selected, 'math.cjs'), 'utf8')).toContain('=>0');
    await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
    await service.join();
    const record = service.result(selection);
    expect(record.state, record.reason ?? '').toBe('ready');
    const task = record.result!.task,
      worktree = record.result!.worktree;
    expect(task.id).not.toBe(old.id);
    expect(fs.readFileSync(join(worktree.root, 'answer.txt'), 'utf8')).toBe(
      'later ready-tree content\n',
    );
    expect(fs.readFileSync(join(worktree.root, 'binary.bin'))).toEqual(
      Buffer.from([0, 255, 10, 0]),
    );
    expect(fs.statSync(join(worktree.root, 'binary.bin')).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(join(worktree.root, 'math.cjs'), 'utf8')).toContain('=>a+b');
    await expect(
      new adapters.GitCodingWorktrees(record.preview.plan.managedDirectory).verify(task, worktree),
    ).resolves.toBeUndefined();
    expect(store.coding.atomic((tx) => tx.task(old.id))).toEqual(old);
    expect(store.coding.atomic((tx) => tx.changeset(artifact.hash))?.files[0]?.after?.text).toBe(
      'old frozen changeset\n',
    );
    expect(fs.readFileSync(join(selected, 'math.cjs'), 'utf8')).toContain('=>0');
    await service.close();
    service = undefined;
    store.close();
    store = undefined;
    const runtime = createRuntime({ dbPath: join(profile, 'runtime.sqlite') });
    try {
      await runtime.ready;
      const access = {
        workspaceId: task.workspaceId,
        roomId: task.ownerRoomId,
        botId: task.devBotId,
        taskId: task.id,
        policyVersion: 1,
        capability: 'project_read' as const,
      };
      expect(runtime.coding.authorize({ ...access, taskId: old.id }).ok).toBe(false);
      expect(runtime.coding.authorize(access).ok).toBe(true);
      // Existing capture limits remain binding; binary bytes were restored, not silently dropped.
      expect((await runtime.codingChanges.capture(access, 'binary-capture')).ok).toBe(false);
      fs.unlinkSync(join(task.worktreeRoot!, 'binary.bin'));
      const fresh = await runtime.codingChanges.capture(access, 'fresh-capture');
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(fresh.value.taskId).toBe(task.id);
    } finally {
      runtime.close();
    }
    const nextArchive = join(root, 'next-archive');
    const nextManifest = await backupProfile(profile, nextArchive);
    expect(nextManifest.format).toBe(2);
    expect(firstManifest.lineage).toBeUndefined();
    const lineage = nextManifest.lineage!;
    expect(lineage.format).toBe(1);
    expect(lineage.parentSnapshotId).toBe(firstSnapshotId);
    expect(lineage.tasks.map((t) => t.source).sort()).toEqual(['live', 'parent']);
    expect(lineage.tasks.find((t) => t.taskId === old.id)?.source).toBe('parent');
    expect(lineage.tasks.find((t) => t.taskId === task.id)?.source).toBe('live');
    expect(lineage.desktopSource).toBe('parent');
    expect(lineage.codingInventory).toBe(
      stores.readCodingBackupInventory(join(profile, 'runtime.sqlite')).hash,
    );
    expect(lineage.intents).toHaveLength(1);
    expect(lineage.intents[0]).toMatchObject({ requestId: selection.requestId, state: 'ready' });
    expect(lineage.intents[0]!.outputs.map((o) => o.kind)).toEqual([
      'materialization',
      'git-administration',
      'git-reference',
      'desktop',
      'registration',
    ]);
    expect(lineage.intents[0]!.outputs.find((o) => o.kind === 'desktop')).toMatchObject({
      presence: 'absent',
      manifestHash: null,
    });
    for (const output of lineage.intents[0]!.outputs.filter((o) => o.kind !== 'desktop'))
      expect(output).toMatchObject({ presence: 'captured' });
    const graph = adapters.verifyProfileLineageGraph(
      nextArchive,
      stores.readProfileRestoreSnapshot,
    );
    expect(graph.manifest.lineage).toEqual(lineage);
    expect(graph.parent?.depth).toBe(2);
    expect(graph.parent?.manifest).toEqual(firstManifest);
    fs.rmSync(profile, { recursive: true });
    fs.rmSync(selected, { recursive: true });
    const again = join(root, 'again');
    restoreProfile(nextArchive, again);
    fs.rmSync(nextArchive, { recursive: true });
    expect(fs.existsSync(join(again, 'restore-lineage', 'parent', 'snapshot.json'))).toBe(true);
    const nextStore = stores.openSqliteStore({ path: join(again, 'runtime.sqlite') });
    try {
      expect(nextStore.rebind.active()).toBeNull();
      expect(nextStore.coding.atomic((tx) => tx.task(old.id))).toEqual(old);
      expect(nextStore.coding.atomic((tx) => tx.task(task.id))).toEqual(task);
      const origin = nextStore.restoration.origin()!;
      expect(origin.profileRoot).toBe(again);
      expect(origin.snapshotId).toBe(snapshotHash(nextManifest));
      const restoration = stores.readRestorationBackupState(join(again, 'runtime.sqlite'));
      expect(restoration.origins).toHaveLength(2);
      expect(restoration.retired).toHaveLength(1);
      expect(restoration.retired[0]!.requestId).toBe(selection.requestId);
      expect(restoration.records.map((r) => r.state)).toEqual(['ready']);
      expect(() =>
        adapters.verifyRestoredProfileOrigin(
          again,
          origin.manifest,
          stores.readProfileRestoreSnapshot,
        ),
      ).not.toThrow();
    } finally {
      nextStore.close();
    }
    let refusal = '';
    try {
      createRuntime({ dbPath: join(again, 'runtime.sqlite') });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBe('restore_restricted');
  } finally {
    await service?.close();
    store?.close();
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 120000);
