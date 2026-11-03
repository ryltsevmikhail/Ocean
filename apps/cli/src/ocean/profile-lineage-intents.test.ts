import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileRebindRecord } from '@runnets/domain';
import * as adapters from '@runnets/tools-node';
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
