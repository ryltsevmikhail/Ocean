import {
  RoomModelPolicyService,
  unconfiguredModelConnection,
  type ConversationStore,
  type ModelConnectionStorePort,
} from '@runnets/application';
import { bindingFixture, createBinding } from './bot-model-binding.js';

export function policyFixture(store?: ConversationStore, connections?: ModelConnectionStorePort) {
  const f = bindingFixture(store, connections);
  f.connections.put(
    {
      ...unconfiguredModelConnection('local-fixture'),
      connectionId: 'local',
      kind: 'local',
      auth: 'none',
      endpoint: 'http://127.0.0.1:1234',
      revision: 1,
      intent: 'disconnected',
    },
    null,
  );
  const created = f.service.create({
    ...createBinding,
    binding: { connectionId: 'local', modelId: 'one' },
  });
  if (!created.ok) throw Error('fixture bot');
  const room = f.old.execute({
    type: 'OpenDirectRoom',
    workspaceId: 'w',
    requestId: 'room',
    botId: created.value.bot.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture room');
  const input = {
    workspaceId: 'w',
    roomId: room.value.data.id,
    requestId: 'policy',
    expectedRevision: 1,
    cloudTransfer: 'deny' as const,
  };
  return {
    ...f,
    bot: created.value.bot,
    room: room.value.data,
    input,
    policy: new RoomModelPolicyService({ store: f.store, connections: f.connections }),
  };
}
