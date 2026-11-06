import type { ChatTurn } from '@runnets/domain';
import { composeRuntimeServices } from './runtime-services.js';
import { runtimeServiceOver as serviceOver } from './runtime-service.js';
import { codingTurnFactory } from './coding-turn-factory.js';
import {
  prepareDesktopBindingUpgrade,
  GitCodingProject,
  GitCodingApplyProject,
  SqliteProjectLeases,
  GitCodingWorktrees,
  GitCodingSnapshots,
} from '@runnets/tools-node';
/** Host composition: ephemeral state or a single-owner durable runtime with reconciliation. */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  runtimeIncomplete,
  restoredRuntimeAdmission,
  bindRuntimeRoomHost,
  codingResolutionAuthority,
} from './runtime-restoration.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  RoomRuntimeRuns,
  RoomTaskPersistence,
  unstartedRoomClaimRuns,
  combineChatTools,
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
    const active = store.rebind.active(),
      origin = store.restoration.origin();
    let restored: boolean;
    try {
      restored = restoredRuntimeAdmission(dirname(dbPath), origin, options.restoredAccess, active);
    } catch (error) {
      store.close();
      throw error;
    }
    try {
      if (!restored)
        store.maintainDesktopBinding((binding, inventory) =>
          prepareDesktopBindingUpgrade(binding, inventory, dirname(dbPath)),
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
      projectId: (root: string) => createHash('sha256').update(root).digest('hex'),
      store: store.coding,
      leases: new SqliteProjectLeases(),
      projects: new GitCodingProject(),
      journal: store.tools,
      ownerId:
        active?.preview.ownerId ?? createHash('sha256').update(realpathSync(dbPath)).digest('hex'),
      clock: deps.clock,
      restored,
    };
    bindRuntimeRoomHost(
      store,
      codingDeps.ownerId,
      !restored && options.pluginMutationsAllowed !== false,
      { origin, active },
    );
    if (!restored) recoverCodingFinalizations(store.finalization, codingDeps.leases);
    const coding = new CodingTaskService(codingDeps);
    const codingApprovals = new CodingApprovalService({
      authorityId: randomUUID(),
      store: store.codingApprovals,
      grantOwnerId: codingDeps.ownerId,
      now: () => deps.clock.now().getTime(),
      admit: (binding, tx, approval) => codingApprovalAdmission(binding, tx, codingDeps, approval),
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
    const services = composeRuntimeServices({
      confirmation: options.serviceConfirmation,
      profile: dirname(dbPath),
      store,
      clock: deps.clock,
      ownerId: codingDeps.ownerId,
      restored: restored || options.pluginMutationsAllowed === false,
      env: options.pluginEnv,
      transportOptions: options.serviceTransportOptions,
    });
    const grantedTools =
      options.pluginTransport === undefined
        ? services.tools
        : {
            forTurn: async (turn: ChatTurn, signal: AbortSignal) => {
              const legacy = await pluginRuntime.tools?.forTurn(turn, signal);
              return (
                combineChatTools(
                  await services.tools.forTurn(turn, signal),
                  legacy
                    ? Object.assign(legacy, {
                        callDigest: (text: string) =>
                          createHash('sha256').update(text).digest('hex'),
                      })
                    : null,
                ) ?? null
              );
            },
          };
    const reviews = new ChatReviewService({ ...deps, tasks: service, journal: store.tools });
    const codingTools = options.codingTools
      ? codingTurnFactory({
          ...options.codingTools,
          store: store.coding,
          tasks: coding,
          approvals: codingApprovals,
          journal: store.tools,
          leases: codingDeps.leases,
          evidence: store.codingEvidence,
        })
      : undefined;
    const chat = new DirectChatService({
      reviews,
      sha256: codingDeps.projectId,
      ...deps,
      tasks: service,
      grantedTools,
      ...(codingTools ? { codingTools } : {}),
    });
    const codingApply = new CodingApplyService(
      store.codingApplications,
      new GitCodingApplyProject(),
      (task, tx) => codingApplyAdmission(task, tx, codingDeps),
    );
    const broadcasts = new RoomBroadcastService({ ...deps, nextId: deps.nextId });
    const roomTasks = new RoomTaskPersistence({
      ...deps,
      ownerId: codingDeps.ownerId,
      sha256: codingDeps.projectId,
    });
    const ready = chat.recover().then(() => {
      // Unfinished batches pause only after started children were resolved by chat recovery.
      broadcasts.recover();
      codingApply.recover();
      // Lower crashed plugin operations to `uncertain` before generic journal recovery.
      pluginRuntime.operations?.recover();
      return reconcileInterrupted(service, store.tools, (id) =>
        unstartedRoomClaimRuns(roomTasks.deps).includes(id),
      );
    });
    return {
      restored,
      roomTasks,
      ...(codingTools ? { codingTools } : {}),
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
      services,
      grantedTools,
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
          ...codingResolutionAuthority(codingDeps),
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
      reviews,
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
