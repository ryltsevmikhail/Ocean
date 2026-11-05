import { CodingFinalizationService, RuntimeOwnerDecisions } from '@runnets/application';
import type { consumerFixture } from './coding-consumer.js';
import { projectId } from './coding-consumer.js';
/** Actual service and SQLite decisions; only the external registry adapter is scripted. */
export function consumerFinalization(f: ReturnType<typeof consumerFixture>) {
  const owner = new RuntimeOwnerDecisions(f.store.ownerDecisions, () => 100);
  const released: string[] = [];
  const registry = { path: '/registry/leases.sqlite', schema: 'project_leases_v1' };
  const service = new CodingFinalizationService({
    store: f.store.finalization,
    owner,
    ownerId: 'owner',
    epochId: null,
    restored: false,
    clock: f.deps.clock,
    digest: projectId,
    nextId: () => 'finalize-b',
    leases: {
      ...f.deps.leases,
      identity: () => registry,
      releaseReceipt: () => null,
      releaseExact: (lease, intent) => {
        if (f.store.coding.atomic((tx) => tx.task(lease.taskId))?.status !== 'finalizing')
          throw Error('release before durable disable');
        released.push(lease.taskId);
        f.live.delete(lease.token);
        return { outcome: 'released', receipt: { ...intent, version: 1, registry } };
      },
    },
  });
  const selection = { workspaceId: 'ws', roomId: 'room', taskId: f.b.id, requestId: 'finalize-b' };
  return { owner, service, released, selection };
}
