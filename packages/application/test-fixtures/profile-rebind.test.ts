import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as app from '@runnets/application';
import { InMemoryOwnerDecisions, InMemoryProjectLeases } from '@runnets/store';
import type {
  CodingTask,
  ProfileRebindRecord,
  ProfileRebindHold,
  ProfileRebindSelection,
  RestoreOrigin,
} from '@runnets/domain';
import type {
  ProfileRebindStore,
  ProfileRebindTransaction,
  ProfileRebindFiles,
} from '@runnets/application';
const h = 'a'.repeat(64),
  base = 'b'.repeat(40);
export function rebindFixture() {
  const origin: RestoreOrigin = {
    version: 1,
    snapshotId: h,
    profileRoot: '/restored',
    profileId: h,
    sourceOwners: ['old'],
    manifest: {
      format: 2,
      sha256: h,
      bytes: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      cli: 'test',
      node: 'test',
      summary: {
        schema: 13,
        rooms: 2,
        messages: 0,
        positions: [],
        pendingEffects: 0,
        unfinishedRuns: 0,
        heldRooms: 0,
      },
      assets: {
        catalog: h,
        codingInventory: h,
        desktopInventory: h,
        worktrees: h,
        recovery: h,
        dependencies: h,
        desktop: null,
      },
    },
  };
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  Object.assign(origin, {
    profileId: digest('/restored'),
    snapshotId: digest(JSON.stringify(origin.manifest)),
  });
  const policy = {
    version: 1 as const,
    devCapabilities: ['project_read', 'propose_write'] as const,
    reviewCapabilities: ['changeset_read'] as const,
    testPresets: [],
  };
  const old: CodingTask = {
    id: 'old-task',
    workspaceId: 'ws',
    projectRoot: '/old',
    baseCommit: base,
    worktreeRoot: '/old-worktree',
    ownerRoomId: 'room',
    devBotId: 'dev',
    reviewRoomId: 'review',
    reviewBotId: 'reviewer',
    status: 'reserved',
    policyVersion: 1,
    policy,
    createdAt: '2026-01-01T00:00:00.000Z',
    lease: {
      ownerId: 'old',
      projectRoot: '/old',
      taskId: 'old-task',
      requestId: 'old-start',
      binding: 'old',
      kind: 'coding',
      token: 'old-token',
    },
  };
  const input: ProfileRebindSelection = {
    requestId: 'rebind',
    workspaceId: 'ws',
    roomId: 'room',
    profileId: origin.profileId,
    snapshotId: origin.snapshotId,
    sourceOwnerId: 'old',
    taskId: 'old-task',
    projectRoot: '/new',
    baseCommit: base,
    treeHash: h,
    policy,
  };
  const rows = new Map<string, ProfileRebindRecord>();
  let holds: ProfileRebindHold[] = [],
    effects = 0,
    published = false,
    changed = false,
    planRoot: string | null = null,
    planTree: string | null = null;
  const tx: ProfileRebindTransaction = {
    observe: () => {},
    origin: () => structuredClone(origin),
    task: (id) => (id === old.id ? structuredClone(old) : null),
    participates: (ws, room, bot) =>
      ws === 'ws' &&
      ((room === 'room' && bot === 'dev') || (room === 'review' && bot === 'reviewer')),
    holds: () => structuredClone(holds),
    record: (id) => structuredClone(rows.get(id) ?? null),
    busy: () =>
      [...rows.values()].some((r) => ['confirmed', 'preparing', 'ready', 'held'].includes(r.state)),
    save: (value, expected) => {
      if ((rows.get(value.requestId)?.revision ?? null) !== expected) return false;
      rows.set(value.requestId, structuredClone(value));
      return true;
    },
    publish: (value) => {
      rows.set(value.requestId, structuredClone(value));
      published = true;
    },
  };
  const store: ProfileRebindStore = {
    active: () => [...rows.values()].find((r) => r.state === 'ready') ?? null,
    atomic: (fn) => fn(tx),
    recover: () => {},
  };
  const leases = new InMemoryProjectLeases();
  const files: ProfileRebindFiles = {
    inspect: async ({ selection }) => ({
      project: {
        root: planRoot ?? selection.projectRoot,
        baseCommit: base,
        treeHash: planTree ?? (changed ? 'c'.repeat(64) : h),
        witness: 'project-inode',
      },
      worktree: { root: '/new-worktree', branch: 'new-branch', gitCommonDir: '/new/.git' },
      managedDirectory: '/managed',
      assetDirectory: '/restored/rebind-epoch',
      treeHash: h,
      virtualHash: h,
      changesetHashes: [h],
      registration: { id: 'recovered', root: '/new', testPresets: [], mounts: [] },
      desktop: null,
      evidenceWitness: 'frozen-inode',
      inertAssets: [{ kind: 'old-git-administration', identity: h }],
      observations: [],
      gitTemporaryRoot: '/new/profile/rebind/fresh-git',
      gitAdministration: '/new/project/.git/worktrees/fresh-git',
    }),
    prepare: async (record) => {
      expect(rows.get(record.requestId)?.state).toBe('preparing');
      expect(leases.owns(record.projectLease!)).toBe(true);
      expect(leases.owns(record.worktreeLease!)).toBe(true);
      effects++;
      const p = record.preview;
      const task = {
        ...old,
        id: p.successorTaskId,
        projectRoot: '/new',
        worktreeRoot: p.plan.worktree.root,
        lease: record.projectLease!,
        policy: p.selection.policy,
        createdAt: new Date(record.createdAt).toISOString(),
      };
      return {
        task,
        worktree: {
          ...p.plan.worktree,
          taskId: task.id,
          workspaceId: 'ws',
          projectRoot: '/new',
          baseCommit: base,
          lease: record.worktreeLease!,
          state: 'ready',
        },
        desktop: null,
        restoredTreeHash: h,
        virtualHash: h,
      };
    },
    verify: async () => {},
  };
  let at = 1000,
    sequence = 0;
  const owner = new app.RuntimeOwnerDecisions(new InMemoryOwnerDecisions(), () => at);
  const service =
    app.ProfileRebindService &&
    new app.ProfileRebindService({
      store,
      files,
      leases,
      owner,
      now: () => at,
      nextId: () => 'fresh-' + ++sequence,
      digest,
    });
  return {
    service,
    origin,
    owner,
    input,
    rows,
    old,
    leases,
    files,
    effects: () => effects,
    published: () => published,
    change: () => {
      changed = true;
    },
    planRoot: (value: string) => {
      planRoot = value;
    },
    planTree: (value: string) => {
      planTree = value;
    },
    expire: () => {
      at += 300000;
    },
    hold: () => {
      holds = [{ id: 'unknown-provider', kind: 'provider', outcome: 'uncertain', scope: 'global' }];
    },
  };
}
