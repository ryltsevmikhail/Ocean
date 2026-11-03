import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileRebindRecord } from '@runnets/domain';
import { validProfileBackupManifest } from '@runnets/domain';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { createRuntime } from '../runtime.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function environment(prefix: string) {
  const root = fs.mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  return root;
}
async function firstGeneration(prefix: string) {
  const root = environment(prefix),
    f = await codingWorkflowFixture('direct');
  try {
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'frozen text\n');
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
    const archive = join(root, 'a1');
    const manifest = await backupProfile(f.directory, archive, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.directory, { recursive: true, force: true });
    return { root, archive, manifest };
  } finally {
    f.close();
  }
}
function copyArchive(source: string, destination: string) {
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}
function editManifest(archive: string, edit: (manifest: Record<string, unknown>) => void) {
  const path = join(archive, 'snapshot.json');
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  fs.writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
}
function refusal(action: () => unknown): string {
  try {
    action();
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
it('keeps unlineaged format 2 readable, refuses unknown lineage fields, and chains empty-live generations', async () => {
  const { root, archive, manifest } = await firstGeneration('lineage-base-');
  expect(manifest.lineage).toBeUndefined();
  expect(validProfileBackupManifest(manifest)).toBe(true);
  const profile = join(root, 'p1');
  expect(restoreProfile(archive, profile)).toEqual(manifest);
  const additions: ((m: Record<string, unknown>) => void)[] = [
    (m) => {
      m['lineage'] = { format: 2 };
    },
    (m) => {
      m['lineage'] = { format: 1 };
    },
    (m) => {
      m['unknownField'] = true;
    },
  ];
  for (const edit of additions) {
    const copy = join(root, 'mutated-' + roots.length + '-' + Math.random().toString(36).slice(2));
    copyArchive(archive, copy);
    editManifest(copy, edit);
    expect(refusal(() => restoreProfile(copy, copy + '-out'))).toBe('invalid_backup');
    expect(fs.existsSync(copy + '-out')).toBe(false);
  }
  fs.rmSync(archive, { recursive: true });
  const second = join(root, 'a2');
  const secondManifest = await backupProfile(profile, second);
  const lineage = secondManifest.lineage!;
  expect(lineage.parentSnapshotId).toBe(hash(manifest));
  expect(lineage.tasks.every((t) => t.source === 'parent')).toBe(true);
  expect(lineage.intents).toHaveLength(0);
  expect(stores.readCodingBackupInventory(join(profile, 'runtime.sqlite')).tasks).toHaveLength(1);
  const graph = adapters.verifyProfileLineageGraph(second, stores.readProfileRestoreSnapshot);
  expect(graph.parent?.manifest).toEqual(manifest);
  expect(graph.catalog.inventory.tasks).toHaveLength(0);
  fs.rmSync(profile, { recursive: true });
  const quarantine = join(root, 'q1');
  const quarantined = restoreProfile(second, quarantine);
  if (quarantined.format !== 2) throw Error('expected format 2');
  expect(quarantined.lineage).toEqual(lineage);
  const state = stores.readRestorationBackupState(join(quarantine, 'runtime.sqlite'));
  expect(state.origins).toHaveLength(2);
  expect(state.origin?.snapshotId).toBe(hash(secondManifest));
  expect(state.activeRequestId).toBeNull();
  expect(fs.existsSync(join(quarantine, 'restore-lineage', 'parent', 'snapshot.json'))).toBe(true);
  expect(() =>
    adapters.verifyRestoredProfileOrigin(
      quarantine,
      state.origin!.manifest,
      stores.readProfileRestoreSnapshot,
    ),
  ).not.toThrow();
  expect(refusal(() => createRuntime({ dbPath: join(quarantine, 'runtime.sqlite') }))).toBe(
    'restore_restricted',
  );
}, 120000);
it('refuses tampered lineage partitions, records, intents and parent proof', async () => {
  const { root, archive, manifest } = await firstGeneration('lineage-tamper-');
  const profile = join(root, 'p1');
  restoreProfile(archive, profile);
  fs.rmSync(archive, { recursive: true });
  const second = join(root, 'a2');
  const secondManifest = await backupProfile(profile, second);
  const tamper: ((m: Record<string, unknown>) => void)[] = [
    (m) => {
      (m['lineage'] as Record<string, unknown>).recordsHash = 'f'.repeat(64);
    },
    (m) => {
      (m['lineage'] as Record<string, unknown>).codingInventory = 'f'.repeat(64);
    },
    (m) => {
      const lineage = m['lineage'] as { tasks: { taskId: string; source: string }[] };
      lineage.tasks[0]!.source = lineage.tasks[0]!.source === 'parent' ? 'live' : 'parent';
    },
  ];
  for (const edit of tamper) {
    const copy = join(root, 'tampered-' + Math.random().toString(36).slice(2));
    copyArchive(second, copy);
    editManifest(copy, edit);
    expect(refusal(() => restoreProfile(copy, copy + '-out'))).toBe('invalid_backup');
    expect(fs.existsSync(copy + '-out')).toBe(false);
  }
  // A complete parent snapshot is required; deleting it is detected before any output exists.
  const missing = join(root, 'missing-parent');
  copyArchive(second, missing);
  fs.rmSync(join(missing, 'lineage', 'parent', 'snapshot.json'));
  expect(refusal(() => restoreProfile(missing, missing + '-out'))).toBe('invalid_backup');
  expect(secondManifest.lineage!.parentSnapshotId).toBe(hash(manifest));
  expect(validProfileBackupManifest(secondManifest)).toBe(true);
  const forged = structuredClone(secondManifest) as unknown as Record<string, unknown>;
  (forged['lineage'] as Record<string, unknown>)['unexpected'] = true;
  expect(validProfileBackupManifest(forged)).toBe(false);
}, 120000);
function syntheticRecord(
  root: string,
  state: ProfileRebindRecord['state'],
  options: { worktreeLease?: boolean; desktop?: boolean } = {},
): ProfileRebindRecord {
  const profile = join(root, 'profile'),
    projectRoot = join(root, 'project');
  const epochId = '11111111-1111-4111-8111-111111111111';
  const ownerId = hash(profile) + ':' + epochId,
    successorTaskId = '22222222-2222-4222-8222-222222222222';
  const assetDirectory = join(profile, 'rebind-' + epochId);
  const managedDirectory = join(assetDirectory, 'materialized/tree');
  const slot = hash([ownerId, projectRoot, successorTaskId]);
  const worktree = {
    root: join(managedDirectory, slot),
    branch: 'codex/ocean/' + slot,
    gitCommonDir: join(projectRoot, '.git'),
  };
  return {
    requestId: 'intent-request',
    revision: 1,
    decisionId: 'decision',
    bindingDigest: 'a'.repeat(64),
    preview: {
      selection: {
        requestId: 'intent-request',
        workspaceId: 'ws',
        roomId: 'room',
        profileId: hash(profile),
        snapshotId: 'b'.repeat(64),
        sourceOwnerId: 'owner',
        taskId: 'task',
        projectRoot,
        baseCommit: 'c'.repeat(40),
        treeHash: 'd'.repeat(64),
        policy: {
          version: 1,
          devCapabilities: [],
          reviewCapabilities: ['changeset_read'],
          testPresets: [],
        },
      },
      origin: {
        version: 1,
        snapshotId: 'b'.repeat(64),
        manifest: {} as never,
        profileRoot: profile,
        profileId: hash(profile),
        sourceOwners: ['owner'],
      },
      originalTask: {} as never,
      epochId,
      ownerId,
      successorTaskId,
      plan: {
        project: {
          root: projectRoot,
          baseCommit: 'c'.repeat(40),
          treeHash: 'd'.repeat(64),
          witness: 'witness',
        },
        worktree,
        managedDirectory,
        assetDirectory,
        gitTemporaryRoot: join(assetDirectory, slot),
        gitAdministration: join(worktree.gitCommonDir, 'worktrees', slot),
        treeHash: 'e'.repeat(64),
        virtualHash: 'f'.repeat(64),
        changesetHashes: [],
        registration: { id: 'rebind', root: projectRoot, testPresets: [], mounts: [] },
        desktop: options.desktop
          ? { root: join(profile, 'desktop-' + epochId, 'tree'), archiveHash: 'a'.repeat(64) }
          : null,
        evidenceWitness: 'witness',
        inertAssets: [],
        observations: [],
      },
      holds: [],
      postSnapshotInterval: 'unknown-never-replayed',
    },
    createdAt: 0,
    expiresAt: 1,
    state,
    projectLease: options.worktreeLease
      ? {
          ownerId,
          taskId: successorTaskId,
          requestId: 'lease',
          binding: 'binding',
          kind: 'coding',
          projectRoot,
          token: 'token',
        }
      : null,
    worktreeLease: options.worktreeLease
      ? {
          ownerId,
          taskId: successorTaskId,
          requestId: 'worktree-lease',
          binding: 'binding',
          kind: 'coding',
          projectRoot: worktree.root,
          token: 'token',
        }
      : null,
    result:
      state === 'ready'
        ? {
            task: {} as never,
            worktree: {} as never,
            desktop: null,
            restoredTreeHash: 'e'.repeat(64),
            virtualHash: 'f'.repeat(64),
          }
        : null,
    reason: null,
  } as ProfileRebindRecord;
}
it('derives every intent selector from the durable plan and enforces consumed-state shapes', () => {
  const root = environment('lineage-intent-');
  const record = syntheticRecord(root, 'preparing', { worktreeLease: true });
  const outputs = adapters.lineageIntentOutputs(join(root, 'profile'), record);
  expect(outputs.map((o) => o.kind)).toEqual([
    'materialization',
    'git-administration',
    'git-reference',
    'desktop',
    'registration',
  ]);
  expect(outputs.map((o) => o.mode)).toEqual([
    'directory',
    'directory',
    'file',
    'directory',
    'file',
  ]);
  expect(outputs[3]).toMatchObject({ path: null });
  expect(outputs[0]!.path).toBe(record.preview.plan.managedDirectory);
  const forged = structuredClone(record) as unknown as {
    preview: { plan: { gitTemporaryRoot: string } };
  };
  forged.preview.plan.gitTemporaryRoot = '/foreign';
  expect(() =>
    adapters.lineageIntentOutputs(join(root, 'profile'), forged as unknown as ProfileRebindRecord),
  ).toThrow('invalid_rebind_identity');
  for (const state of ['preview', 'confirmed', 'refused'] as const)
    expect(() =>
      adapters.requireLineageOutput(syntheticRecord(root, state), 'registration', true),
    ).toThrow('unowned_rebind_output');
  expect(() =>
    adapters.requireLineageOutput(syntheticRecord(root, 'preparing'), 'registration', true),
  ).toThrow('unowned_rebind_output');
  expect(() => adapters.requireLineageOutput(record, 'registration', true)).not.toThrow();
  expect(() =>
    adapters.requireLineageOutput(syntheticRecord(root, 'ready'), 'registration', false),
  ).toThrow('missing_rebind_output');
  expect(() => adapters.requireLineageOutput(record, 'desktop', true)).toThrow(
    'unowned_rebind_output',
  );
  expect(() => adapters.requireLineageOutput(record, 'desktop', false)).not.toThrow();
  const ready = syntheticRecord(root, 'ready', { worktreeLease: true });
  expect(() => adapters.requireLineageOutput(ready, 'registration', true)).not.toThrow();
});
it('refuses dangling materialization links and torn registrations instead of omitting them', () => {
  const root = environment('lineage-shape-');
  const record = syntheticRecord(root, 'preparing', { worktreeLease: true });
  const profile = join(root, 'profile'),
    plan = record.preview.plan;
  fs.mkdirSync(join(plan.managedDirectory, 'slot'), { recursive: true, mode: 0o700 });
  fs.symlinkSync('missing-slot', join(plan.managedDirectory, 'workspace'));
  expect(() => adapters.inspectLineageIntent(profile, record)).toThrow('unsupported_rebind_output');
  fs.unlinkSync(join(plan.managedDirectory, 'workspace'));
  fs.writeFileSync(join(profile, 'coding-projects.json'), '{"torn"', { mode: 0o600 });
  expect(() => adapters.inspectLineageIntent(profile, record)).toThrow('unsupported_rebind_output');
  fs.unlinkSync(join(profile, 'coding-projects.json'));
  fs.rmSync(plan.assetDirectory, { recursive: true });
  expect(
    adapters
      .inspectLineageIntent(profile, syntheticRecord(root, 'preview'))
      .outputs.every((o) => o.presence === 'absent'),
  ).toBe(true);
});
it('caps the lineage chain at eight complete generations and refuses a ninth', async () => {
  const { root, archive } = await firstGeneration('lineage-depth-');
  let current = archive,
    profile = join(root, 'p1');
  restoreProfile(current, profile);
  for (let generation = 2; generation <= 8; generation++) {
    const next = join(root, 'a' + generation);
    await backupProfile(profile, next);
    const graph = adapters.verifyProfileLineageGraph(next, stores.readProfileRestoreSnapshot);
    let depth = 0;
    for (let node: typeof graph | null = graph; node; node = node.parent) depth++;
    expect(depth).toBe(generation);
    fs.rmSync(profile, { recursive: true });
    fs.rmSync(current, { recursive: true });
    profile = join(root, 'p' + generation);
    restoreProfile(next, profile);
    current = next;
  }
  const tooDeep = join(root, 'a9');
  await expect(backupProfile(profile, tooDeep)).rejects.toThrow('profile_lineage_limit');
  expect(fs.existsSync(tooDeep)).toBe(false);
}, 240000);
