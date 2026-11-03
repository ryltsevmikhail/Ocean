import { createHash } from 'node:crypto';
import type { CodingTask, CodingWorktree, ProjectLease } from '@runnets/domain';
import type {
  CodingFinalizationStore,
  CodingFinalizationTransaction,
} from './coding-finalization-ports.js';
import type { CodingFinalizationRecord } from '@runnets/domain';
import { CodingFinalizationService } from './coding-finalization.js';
import {
  RuntimeOwnerDecisions,
  type DecisionOutcome,
  type OwnerDecision,
  type OwnerDecisionRef,
  type OwnerDecisionScope,
  type OwnerDecisionStore,
} from './owner-decisions.js';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class MemoryOwnerDecisions implements OwnerDecisionStore {
  readonly rows = new Map<string, OwnerDecision>();
  readonly previews = new Map<string, string>();
  insert(card: OwnerDecision, preview: string) {
    this.rows.set(card.decisionId, structuredClone(card));
    this.previews.set(card.decisionId, preview);
  }
  list(scope: OwnerDecisionScope, after: string, limit: number) {
    return [...this.rows.values()]
      .filter(
        (c) =>
          c.workspaceId === scope.workspaceId && c.roomId === scope.roomId && c.decisionId > after,
      )
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId))
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }
  has(id: string) {
    return this.rows.has(id);
  }
  find(ref: OwnerDecisionRef) {
    const card = this.rows.get(ref.decisionId);
    return card &&
      card.workspaceId === ref.workspaceId &&
      card.roomId === ref.roomId &&
      card.runId === ref.runId
      ? structuredClone(card)
      : null;
  }
  preview(ref: OwnerDecisionRef) {
    return this.rows.has(ref.decisionId) ? (this.previews.get(ref.decisionId) ?? null) : null;
  }
  settle(expected: OwnerDecision, outcome: DecisionOutcome) {
    const card = this.rows.get(expected.decisionId);
    if (
      !card ||
      card.status !== 'pending' ||
      card.version !== expected.version ||
      card.bindingDigest !== expected.bindingDigest
    )
      return false;
    this.rows.set(expected.decisionId, { ...card, status: outcome, version: card.version + 1 });
    return true;
  }
  retirePending() {
    for (const [id, card] of this.rows)
      if (card.status === 'pending')
        this.rows.set(id, { ...card, status: 'interrupted', version: card.version + 1 });
  }
}
export class MemoryFinalizationStore implements CodingFinalizationStore {
  readonly tasks = new Map<string, CodingTask>();
  readonly worktrees = new Map<string, CodingWorktree>();
  readonly records = new Map<string, CodingFinalizationRecord>();
  holds: { id: string; kind: string; outcome: string; scope: 'global' | 'task' }[] = [];
  readonly events: string[] = [];
  projectHeld(projectRoot: string) {
    return [...this.records.values()].some(
      (r) => r.projectRoot === projectRoot && ['finalizing', 'uncertain'].includes(r.state),
    );
  }
  recover() {
    for (const [id, record] of this.records)
      if (record.state === 'preview')
        this.records.set(id, {
          ...record,
          revision: record.revision + 1,
          state: 'refused',
          reason: 'confirmation_interrupted',
        });
  }
  unresolvedFinalizing() {
    return [...this.records.values()].filter((r) => r.state === 'finalizing');
  }
  atomic<T>(work: (tx: CodingFinalizationTransaction) => T): T {
    return work({
      task: (id) => this.tasks.get(id) ?? null,
      worktree: (id) => this.worktrees.get(id) ?? null,
      participates: () => true,
      assets: () => ({
        changesets: ['a'.repeat(64)],
        reviews: ['review-1'],
        evidence: ['b'.repeat(64)],
      }),
      holds: () => this.holds,
      record: (id) => this.records.get(id) ?? null,
      active: (taskId) =>
        [...this.records.values()].find((r) => r.taskId === taskId && r.state !== 'refused') ??
        null,
      save: (record, expected) => {
        const old = this.records.get(record.requestId);
        if ((old?.revision ?? null) !== expected) return false;
        if (record.revision !== (expected ?? 0) + 1) return false;
        this.records.set(record.requestId, structuredClone(record));
        return true;
      },
      disable: (record) => {
        if (this.records.get(record.requestId)!.state !== 'preview') throw Error('bad_transition');
        this.events.push('disable');
        const task = this.tasks.get(record.taskId)!;
        if (task.status !== 'reserved') throw Error('task_not_reserved');
        this.tasks.set(task.id, { ...task, status: 'finalizing' });
        this.records.set(record.requestId, structuredClone(record));
      },
      publish: (record) => {
        if (this.records.get(record.requestId)!.state !== 'finalizing')
          throw Error('bad_transition');
        this.events.push('publish');
        const task = this.tasks.get(record.taskId)!;
        this.tasks.set(task.id, { ...task, status: 'finalized' });
        this.records.set(record.requestId, structuredClone(record));
      },
      hold: (record) => {
        if (this.records.get(record.requestId)!.state !== 'finalizing')
          throw Error('bad_transition');
        this.events.push('hold');
        this.records.set(record.requestId, structuredClone(record));
      },
    });
  }
}
export type Release = 'released' | 'registry_missing' | 'absent';
export interface Fixture {
  readonly store: MemoryFinalizationStore;
  readonly owner: MemoryOwnerDecisions;
  readonly decisions: RuntimeOwnerDecisions;
  readonly service: CodingFinalizationService;
  readonly task: CodingTask;
  readonly lease: ProjectLease;
  readonly selection: { workspaceId: string; roomId: string; requestId: string; taskId: string };
  readonly releases: () => number;
  readonly clock: { at: number };
}
export function fixture(
  options: { restored?: boolean; ownerId?: string; release?: Release; now?: number } = {},
): Fixture {
  const store = new MemoryFinalizationStore();
  const owner = new MemoryOwnerDecisions();
  const clock = { at: options.now ?? 1_700_000_000_000 };
  const decisions = new RuntimeOwnerDecisions(owner, () => clock.at);
  const ownerId = options.ownerId ?? 'owner';
  const lease: ProjectLease = {
    ownerId: 'owner',
    taskId: 'task',
    requestId: 'start',
    binding: 'binding',
    kind: 'coding',
    projectRoot: '/project',
    token: 'lease-token',
  };
  const worktree: CodingWorktree = {
    taskId: 'task',
    root: '/project/wt',
    branch: 'task',
    gitCommonDir: '/project/.git',
    projectRoot: '/project',
    baseCommit: 'c'.repeat(40),
    workspaceId: 'ws',
    state: 'ready',
    lease: { ...lease, projectRoot: '/project/wt', requestId: 'worktree' },
  };
  const task: CodingTask = {
    id: 'task',
    workspaceId: 'ws',
    projectRoot: '/project',
    baseCommit: 'c'.repeat(40),
    worktreeRoot: '/project/wt',
    ownerRoomId: 'room',
    devBotId: 'dev',
    reviewBotId: 'review',
    reviewRoomId: 'review-room',
    status: 'reserved',
    policyVersion: 1,
    policy: {
      version: 1,
      devCapabilities: ['project_read'],
      reviewCapabilities: ['changeset_read'],
      testPresets: [],
    },
    lease,
    createdAt: new Date(clock.at).toISOString(),
  };
  store.tasks.set('task', task);
  store.worktrees.set('task', worktree);
  let releases = 0;
  const leases = {
    acquire: () => {
      throw Error('unused');
    },
    owns: (value: ProjectLease) => value.ownerId === 'owner',
    release: () => false,
    identity: () => ({ path: '/registry/leases.sqlite', schema: 'project_leases_v1' }),
    releaseExact: (value: ProjectLease) => {
      releases++;
      store.events.push('release');
      if (store.tasks.get('task')!.status !== 'finalizing') throw Error('release_before_disable');
      if (options.release === 'registry_missing')
        return { outcome: 'registry_missing' as const, detail: 'absent' };
      if (options.release === 'absent') return { outcome: 'absent' as const };
      return {
        outcome: 'released' as const,
        receipt: {
          version: 1 as const,
          operationId: 'finalize-1',
          bindingDigest: store.records.get('finalize-1')!.bindingDigest,
          taskId: 'task',
          workspaceId: 'ws',
          ownerId: value.ownerId,
          projectRoot: '/project',
          tokenHash: digest(value.token),
          holderHash: digest(JSON.stringify(value)),
          releasedAt: new Date(clock.at).toISOString(),
          registry: { path: '/registry/leases.sqlite', schema: 'project_leases_v1' },
        },
      };
    },
    releaseReceipt: () => null,
  };
  let sequence = 0;
  return {
    store,
    owner,
    decisions,
    service: new CodingFinalizationService({
      store,
      leases,
      owner: decisions,
      clock: { now: () => new Date(clock.at) },
      ownerId,
      epochId: null,
      restored: options.restored ?? false,
      nextId: () => 'id-' + String(++sequence),
      digest,
    }),
    task,
    lease,
    selection: { workspaceId: 'ws', roomId: 'room', requestId: 'finalize-1', taskId: 'task' },
    releases: () => releases,
    clock,
  };
}
export async function until(check: () => boolean, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error('condition_timeout');
}
export const ref = (card: OwnerDecision) => ({
  workspaceId: card.workspaceId,
  roomId: card.roomId,
  runId: card.runId,
  decisionId: card.decisionId,
});
