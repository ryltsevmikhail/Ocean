import type { RuntimeObservers } from './observe.js';
import type { RuntimeReply } from './queries.js';
import { createHash } from 'node:crypto';
import { systemClock } from '@runnets/store';
import type { ProviderActivationPort, ImageAssetResolverPort } from '@runnets/application';
import type { Runtime } from '../runtime.js';
import { RuntimeBroadcasts } from './broadcast.js';
import { RuntimeRoomTasks } from './room-tasks.js';
export function hostRoomTasks(
  runtime: Runtime,
  resolver: ProviderActivationPort,
  instance: string,
  images?: ImageAssetResolverPort,
  capacity?: 1,
  observers?: RuntimeObservers,
) {
  if (
    !runtime.broadcasts ||
    !runtime.conversationStore ||
    !runtime.openRoomRuns ||
    !runtime.ownerId ||
    !runtime.roomTasks
  )
    throw Error('durable_runtime_required');
  const clock = systemClock;
  const execution = {
    tasks: runtime.service,
    store: runtime.conversationStore,
    clock,
    reviews: runtime.reviews,
    sha256: (s: string) => createHash('sha256').update(s).digest('hex'),
    ...(runtime.grantedTools ? { grantedTools: runtime.grantedTools } : {}),
  };
  const broadcasts = new RuntimeBroadcasts({
    service: runtime.broadcasts,
    execution,
    clock,
    resolver,
    ...(images ? { images } : {}),
  });
  const roomTasks = new RuntimeRoomTasks(
    runtime.roomTasks,
    {
      ...runtime.roomTasks.deps,
      resolver,
      codingAvailable: runtime.codingTools !== undefined,
      ...(images ? { images } : {}),
    },
    {
      ...execution,
      grantedTools: runtime.services!.tools,
      ...(runtime.codingTools ? { codingTools: runtime.codingTools } : {}),
    },
    runtime.openRoomRuns().reads,
    instance,
    capacity,
    observers,
  );
  return { broadcasts, roomTasks };
}

/** Readiness mutations wake existing queued roots only after their ordinary owner reply settles. */
export async function wakeRoomTasksAfter(
  reply: RuntimeReply | Promise<RuntimeReply>,
  method: string,
  rooms: RuntimeRoomTasks,
) {
  const result = await reply;
  if (
    'result' in result &&
    [
      'modelConnections.check',
      'modelConnections.set',
      'modelConnections.disconnect',
      'modelConnections.removeSavedKey',
      'provider.check',
      'provider.set',
      'provider.disconnect',
      'bots.setModelBinding',
      'rooms.setModelPolicy',
    ].includes(method)
  )
    rooms.wake(true);
  return result;
}
