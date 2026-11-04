/* eslint-disable no-restricted-imports -- Test-only fixture for the same application package. */
import { InMemoryConversationStore } from '@runnets/store';
import type { ChatTurn } from '@runnets/domain';
import { ConversationService } from '../src/conversations.js';
import { RoomBroadcastService } from '../src/room-broadcast.js';

export function broadcastFixture() {
  const store = new InMemoryConversationStore();
  let ids = 0;
  const nextId = () => String(++ids).padStart(4, '0');
  const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };
  const conversations = new ConversationService({ store, clock, nextId });
  conversations.execute({
    type: 'BindWorkspace',
    requestId: 'init',
    workspaceId: 'ws',
    root: '/project',
  });
  const bot = (handle: string) => {
    const created = conversations.execute({
      type: 'CreateBot',
      workspaceId: 'ws',
      requestId: 'bot-' + handle,
      handle,
      name: handle,
      role: 'fixture',
      provider: 'test',
      model: 'test',
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('fixture bot');
    return created.value.data.id;
  };
  const dev = bot('dev');
  const review = bot('review');
  const room = conversations.execute({
    type: 'CreateGroupRoom',
    workspaceId: 'ws',
    requestId: 'room',
    title: 'Team',
    botIds: [review, dev],
  });
  if (!room.ok || room.value.kind !== 'room' || room.value.data.kind !== 'group')
    throw Error('fixture room');
  const service = new RoomBroadcastService({ store, clock, nextId });
  const update = (turn: ChatTurn, status: ChatTurn['status']) =>
    store.atomic((tx) => {
      const current = tx.chatTurn(turn.id);
      if (current === null) throw Error('missing turn');
      tx.putChatTurn({ ...current, status });
    });
  return {
    store,
    conversations,
    service,
    clock,
    roomId: room.value.data.id,
    botIds: room.value.data.botIds,
    dev,
    review,
    nextId,
    update,
  };
}
