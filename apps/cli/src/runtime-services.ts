import { createHash, randomUUID } from 'node:crypto';
import {
  OwnerScopeService,
  ServiceCallAdmissionService,
  ServiceTurnTools,
  beginServiceCatalogRefresh,
  publishServiceCatalogRefresh,
  currentServiceCatalog,
  type Clock,
  type ServiceAuthorityStorePort,
  type ConversationStore,
  type CodingStore,
} from '@runnets/application';
import {
  canonicalJson,
  type ServiceCatalogSnapshot,
  type ServiceConnection,
} from '@runnets/domain';
import {
  createMcpServiceTransport,
  type McpServiceTransportOptions,
} from '@runnets/integrations-mcp';
export interface RuntimeServices {
  readonly tools: ServiceTurnTools;
  /** Trusted in-process capability only; never serialized to clients/models. */
  readonly owner: OwnerScopeService;
  start(): Promise<void>;
  refresh(connectionId: string, signal?: AbortSignal): Promise<ServiceCatalogSnapshot>;
  drain(): Promise<'settled' | 'uncertain'>;
}
export interface RuntimeServicesInput {
  readonly profile: string;
  readonly store: {
    readonly serviceAuthority: ServiceAuthorityStorePort;
    readonly conversations: ConversationStore;
    readonly coding: CodingStore;
  };
  readonly ownerId: string;
  readonly clock: Clock;
  readonly restored: boolean;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Explicit trusted test controls; absent production binds durable workspaceRoot. */
  readonly transportOptions?: Omit<McpServiceTransportOptions, 'refreshNeeded'> | undefined;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** One runtime-owned transport and a bounded, coalesced metadata job per connection. */
export function composeRuntimeServices(input: RuntimeServicesInput): RuntimeServices {
  const store = input.store.serviceAuthority,
    now = () => input.clock.now().getTime();
  const stop = new AbortController();
  const jobs = new Map<string, Promise<ServiceCatalogSnapshot>>();
  let started = false,
    draining = false,
    uncertain = false;
  const metadata = (expected: ServiceConnection) =>
    !draining &&
    !input.restored &&
    store.atomic((tx) => {
      const c = tx.connection(expected.id);
      return (
        !!c &&
        c.state === 'active' &&
        c.trust.ownerId === input.ownerId &&
        c.trust.metadataPermission === 'allow' &&
        canonicalJson(c) === canonicalJson(expected)
      );
    });
  const transport = createMcpServiceTransport({
    stdio: { profileRoot: input.profile },
    resolveCredential: (ref) => {
      if (!/^env:[A-Z_][A-Z0-9_]*$/.test(ref)) return null;
      const value = (input.env ?? process.env)[ref.slice(4)];
      return typeof value === 'string' && value.length ? value : null;
    },
    ...input.transportOptions,
    refreshNeeded: (id) => {
      if (started && !draining) void refresh(id).catch(() => {});
    },
  });
  function refresh(id: string, signal?: AbortSignal): Promise<ServiceCatalogSnapshot> {
    const previous = jobs.get(id);
    if (previous) return previous;
    if (!started || draining || input.restored || jobs.size >= 8)
      return Promise.reject(Error('metadata_unavailable'));
    const work = (async () => {
      const connection = store.atomic((tx) => {
        const c = tx.connection(id);
        if (!c || c.trust.ownerId !== input.ownerId) throw Error('metadata_permission_required');
        return beginServiceCatalogRefresh(tx, id);
      });
      const candidate = await transport.discover(connection, {
        signal: AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]),
        deadlineMs: 15000,
        authorizeMetadata: () => metadata(connection),
      });
      const snapshot = { ...candidate, id: 'catalog_' + randomUUID().replaceAll('-', '') };
      try {
        if (
          !metadata(connection) ||
          !store.atomic((tx) => publishServiceCatalogRefresh(tx, snapshot)) ||
          !transport.activate(candidate, snapshot, () =>
            store.atomic((tx) => {
              const c = tx.connection(id);
              if (
                !c ||
                draining ||
                c.trust.ownerId !== input.ownerId ||
                c.trust.metadataPermission !== 'allow'
              )
                return false;
              const actual = currentServiceCatalog(tx, c);
              return !!actual && canonicalJson(actual) === canonicalJson(snapshot);
            }),
          )
        )
          throw Error('catalog_stale');
        return snapshot;
      } catch (error) {
        const cleanup = await transport.disposeCandidate(candidate);
        if (cleanup.status === 'unknown') uncertain = true;
        throw error;
      }
    })();
    jobs.set(id, work);
    void work
      .finally(() => {
        if (jobs.get(id) === work) jobs.delete(id);
      })
      .catch(() => {});
    return work;
  }
  const admission = new ServiceCallAdmissionService({
    store,
    transport,
    now,
    restored: input.restored,
  });
  return {
    owner: new OwnerScopeService(store, input.ownerId, now),
    tools: new ServiceTurnTools({
      store,
      admission,
      ownerId: input.ownerId,
      now,
      restored: input.restored,
      sha256: hash,
      ready: (c, s) => !draining && transport.ready(c, s),
      subject: (turn) => {
        if (turn.continuationReviewId !== undefined) return null;
        const workspace = input.store.conversations.atomic((tx) => tx.workspace());
        if (!workspace || workspace.id !== turn.workspaceId) return null;
        if (!turn.codingTaskId)
          return {
            workspaceId: workspace.id,
            roomId: turn.roomId,
            botId: turn.bot.id,
            projectId: hash(workspace.root),
            taskId: null,
          };
        const task = input.store.coding.atomic((tx) => tx.task(turn.codingTaskId!));
        return task &&
          task.workspaceId === turn.workspaceId &&
          task.ownerRoomId === turn.roomId &&
          task.devBotId === turn.bot.id &&
          task.status === 'reserved'
          ? {
              workspaceId: workspace.id,
              roomId: turn.roomId,
              botId: turn.bot.id,
              projectId: hash(task.projectRoot),
              taskId: task.id,
            }
          : null;
      },
    }),
    refresh,
    async start() {
      if (started || draining) return;
      started = true;
      if (input.restored) return;
      const connections = store.atomic((tx) => tx.listConnections());
      // No queue: startup runs at most one bounded discovery at a time.
      for (const c of connections) {
        if (draining) break;
        if (
          c.state === 'active' &&
          c.trust.ownerId === input.ownerId &&
          c.trust.metadataPermission === 'allow'
        )
          await refresh(c.id).catch(() => {});
      }
    },
    async drain() {
      draining = true;
      stop.abort();
      const closing = transport.close();
      await Promise.allSettled([...jobs.values()]);
      const result = await closing;
      return uncertain || result.status === 'unknown' ? 'uncertain' : 'settled';
    },
  };
}
