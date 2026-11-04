import { runtimeServiceOver as serviceOver } from './runtime-service.js';
import { codingTurnFactory } from './coding-turn-factory.js';
import {
  GitCodingProject,
  GitCodingApplyProject,
  SqliteProjectLeases,
  GitCodingWorktrees,
  GitCodingSnapshots,
} from '@runnets/tools-node';
/** Host composition: ephemeral state or a single-owner durable runtime with reconciliation. */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeIncomplete, restoredRuntimeAdmission } from './runtime-restoration.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  RoomRuntimeRuns,
  CodingTaskService,
  CodingReviewService,
  CodingApplyService,
  CodingApplyInspectionService,
  CodingApplyResolutionService,
  codingApplyAdmission,
  CodingApprovalService,
  codingApprovalAdmission,
  CodingChangesetService,
  ConversationService,
  DirectChatService,
  RoomBroadcastService,
  ChatReviewService,
  reconcileInterrupted,
  recoverCodingFinalizations,
} from '@runnets/application';
import { openSqliteStore, ownSqliteRuntime } from '@runnets/store-sqlite';
import { composeRuntimePlugins } from './runtime-plugins.js';
import { systemClock } from '@runnets/store';
import { createEphemeralRuntime } from './runtime-ephemeral.js';
export type { Runtime, RuntimeOptions } from './runtime-types.js';
import type { Runtime, RuntimeOptions } from './runtime-types.js';

export const RUNTIME_ENV_KEY = 'RUNNE_DB';

/** Durable means a persistent database, durable tool claims, and exclusive recovery ownership. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const dbPath = options.dbPath?.trim() ?? '';
  const persistent = dbPath !== '' && dbPath !== ':memory:';
  const mode = options.mode ?? (persistent ? 'durable' : 'ephemeral');
  if (mode === 'durable' && !persistent)
    throw new Error('Durable mode requires a persistent RUNNE_DB file');
  if (mode === 'ephemeral' && persistent)
    throw new Error('Ephemeral mode cannot use a persistent RUNNE_DB file');
  if (mode === 'ephemeral') return createEphemeralRuntime(options);
  if (runtimeIncomplete(dirname(dbPath))) throw new Error('recovery_required');
  const release = ownSqliteRuntime(dbPath, options.requireUnpublished);
  try {
    const store = openSqliteStore({ path: dbPath });
    const active = store.rebind.active();
    let restored: boolean;
    try {
      restored = restoredRuntimeAdmission(
        dirname(dbPath),
        store.restoration.origin(),
        options.restoredAccess,
        active,
      );
    } catch (error) {
      store.close();
      throw error;
    }
    const service = serviceOver(store.log, store.dedup, true, options.clock);
    const images = options.imageResolver?.(store.desktopAssets);
    const deps = {
      store: store.conversations,
      clock: options.clock ?? systemClock,
      nextId: () => randomUUID().replaceAll('-', ''),
      ...(images === undefined ? {} : { images }),
    };
    const codingDeps = {
      store: store.coding,
      leases: new SqliteProjectLeases(),
      projects: new GitCodingProject(),
      journal: store.tools,
      ownerId:
        active?.preview.ownerId ?? createHash('sha256').update(realpathSync(dbPath)).digest('hex'),
      clock: deps.clock,
      restored,
    };
    if (!restored) recoverCodingFinalizations(store.finalization, codingDeps.leases);
    const coding = new CodingTaskService(codingDeps);
    const codingApprovals = new CodingApprovalService({
      authorityId: randomUUID(),
      store: store.codingApprovals,
      now: () => deps.clock.now().getTime(),
      admit: (binding, tx) => codingApprovalAdmission(binding, tx, codingDeps),
      restored: codingDeps.restored,
    });
    const pluginRuntime = composeRuntimePlugins({
      profile: dirname(dbPath),
      store,
      clock: deps.clock,
      restored,
      ...(options.pluginMutationsAllowed === undefined
        ? {}
        : { mutationsAllowed: options.pluginMutationsAllowed }),
      ...(options.pluginTransport === undefined ? {} : { transport: options.pluginTransport }),
      ...(options.pluginEnv === undefined ? {} : { env: options.pluginEnv }),
    });
    const chat = new DirectChatService({
      ...deps,
      tasks: service,
      ...(pluginRuntime.tools === null ? {} : { grantedTools: pluginRuntime.tools }),
      ...(options.codingTools
        ? {
            codingTools: codingTurnFactory({
              ...options.codingTools,
              store: store.coding,
              tasks: coding,
              approvals: codingApprovals,
              journal: store.tools,
              evidence: store.codingEvidence,
            }),
          }
        : {}),
    });
    const codingApply = new CodingApplyService(
      store.codingApplications,
      new GitCodingApplyProject(),
      (task, tx) => codingApplyAdmission(task, tx, codingDeps),
    );
    const broadcasts = new RoomBroadcastService({ ...deps, nextId: deps.nextId });
    const ready = chat.recover().then(() => {
      // Unfinished batches pause only after started children were resolved by chat recovery.
      broadcasts.recover();
      codingApply.recover();
      // Lower crashed plugin operations to `uncertain` before generic journal recovery.
      pluginRuntime.operations?.recover();
      return reconcileInterrupted(service, store.tools);
    });
    return {
      restored,
      finalization: store.finalization,
      providerConnections: store.providerConnections,
      plugins: {
        catalog: store.pluginCatalog,
        connections: store.pluginConnections,
        access: store.pluginAccess,
        admission: store.pluginAdmission,
        operations: store.pluginOperations,
      },
      pluginRuntime,
      ownerId: codingDeps.ownerId,
      openRebindStore: () => store.rebind,
      service,
      ownerDecisions: store.ownerDecisions,
      desktopAssets: store.desktopAssets,
      openProfileReads: () => store.openProfileReads(codingDeps.ownerId),
      openEndpointProof: () => store.openEndpointProof(),
      openRoomRuns: () =>
        new RoomRuntimeRuns(
          store.openRoomReads(() => deps.clock.now().getTime()),
          service,
        ),
      coding,
      codingApprovals,
      codingEvidence: store.codingEvidence,
      codingApply,
      codingApplyResolution: new CodingApplyResolutionService(
        store.codingResolutions,
        new GitCodingApplyProject(),
        {
          ownerId: codingDeps.ownerId,
          clock: codingDeps.clock,
          admit: (task, tx) => {
            const worktree = tx.worktree(task.id);
            return (
              !codingDeps.restored &&
              task.status === 'reserved' &&
              worktree !== null &&
              worktree.state === 'ready' &&
              worktree.root === task.worktreeRoot &&
              worktree.projectRoot === task.projectRoot &&
              worktree.baseCommit === task.baseCommit &&
              worktree.workspaceId === task.workspaceId &&
              worktree.taskId === task.id &&
              worktree.lease.ownerId === codingDeps.ownerId &&
              worktree.lease.projectRoot === worktree.root &&
              task.lease.projectRoot === task.projectRoot &&
              codingDeps.leases.owns(task.lease) &&
              codingDeps.leases.owns(worktree.lease)
            );
          },
        },
      ),
      codingApplyInspection: new CodingApplyInspectionService(
        store.codingApplications,
        new GitCodingApplyProject(),
        (task) => !codingDeps.restored && task.lease.ownerId === codingDeps.ownerId,
      ),
      codingReview: new CodingReviewService(
        store.codingReviews,
        (task) =>
          !codingDeps.restored &&
          task.status === 'reserved' &&
          task.lease.ownerId === codingDeps.ownerId &&
          task.policy.reviewCapabilities.includes('changeset_read'),
      ),

      codingChanges: new CodingChangesetService({
        ...codingDeps,
        worktrees: new GitCodingWorktrees(
          active?.preview.plan.managedDirectory ?? options.codingWorktreeDirectory,
        ),
        snapshots: new GitCodingSnapshots(),
      }),
      conversations: new ConversationService(deps),
      conversationStore: deps.store,
      chat,
      broadcasts,
      reviews: new ChatReviewService({ ...deps, tasks: service, journal: store.tools }),
      durable: true,
      toolJournal: store.tools,
      ready,
      close(): void {
        try {
          store.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Reject invalid storage selections instead of silently reducing recovery guarantees. */
export function createRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Runtime {
  const mode = env['RUNNE_MODE'];
  if (mode !== undefined && mode !== 'ephemeral' && mode !== 'durable')
    throw new Error('RUNNE_MODE must be ephemeral or durable');
  return createRuntime({ dbPath: env[RUNTIME_ENV_KEY], mode });
}
