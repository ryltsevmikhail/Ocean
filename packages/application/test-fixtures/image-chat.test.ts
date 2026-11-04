/* eslint-disable no-restricted-imports -- Test-only in-memory conversation fixture. */
import { InMemoryConversationStore } from '@runnets/store';
import { encodeDesktopAttachments, type DesktopAttachment } from '@runnets/domain';
import { ConversationService } from '../src/conversations.js';
import type { ImageAssetResolverPort } from '../src/image-content.js';
import { RoomBroadcastService } from '../src/room-broadcast.js';
import {
  DEEPSEEK_MODEL_INFO,
  TINY_IMAGES,
  recordingProvider,
  requestBytesFallback,
  sha256,
} from './image-content-fakes.js';

export const requestId = '22345678-1234-4123-8123-123456789abc';
export const attachment: DesktopAttachment = {
  id: '12345678-1234-4123-8123-123456789abc',
  name: 'photo.png',
  bytes: Buffer.from(TINY_IMAGES['image/png'], 'base64').length,
  sha256: sha256(Buffer.from(TINY_IMAGES['image/png'], 'base64')),
  kind: 'image',
  mime: 'image/png',
};
export const prepared = encodeDesktopAttachments('Что на изображении?', requestId, [attachment]);

export function imageChatFixture(images?: ImageAssetResolverPort) {
  const store = new InMemoryConversationStore();
  let ids = 0;
  const nextId = () => 'id' + String(++ids).padStart(4, '0');
  const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };
  const deps = { store, clock, nextId, ...(images === undefined ? {} : { images }) };
  const conversations = new ConversationService(deps);
  const execute = conversations.execute.bind(conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: 'ws_ocean', root: '/project' });
  const bot = (handle: string, model: string) => {
    const created = execute({
      type: 'CreateBot',
      workspaceId: 'ws_ocean',
      requestId: 'bot-' + handle,
      handle,
      name: handle,
      role: 'fixture',
      provider: 'deepseek',
      model,
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('fixture bot');
    return created.value.data;
  };
  const room = (requestId: string, botId: string) => {
    const created = execute({
      type: 'OpenDirectRoom',
      workspaceId: 'ws_ocean',
      requestId,
      botId,
    });
    if (!created.ok || created.value.kind !== 'room' || created.value.data.kind !== 'direct')
      throw Error('fixture room');
    return created.value.data;
  };
  const flash = bot('flash', 'deepseek-flash');
  const pro = bot('pro', 'deepseek-v4-pro');
  const flashRoom = room('room-flash', flash.id);
  const proRoom = room('room-pro', pro.id);
  const group = execute({
    type: 'CreateGroupRoom',
    workspaceId: 'ws_ocean',
    requestId: 'room-team',
    title: 'Team',
    botIds: [flash.id, pro.id],
  });
  if (!group.ok || group.value.kind !== 'room' || group.value.data.kind !== 'group')
    throw Error('fixture group');
  const provider = recordingProvider({
    modelInfo: DEEPSEEK_MODEL_INFO,
    requestBytes: requestBytesFallback,
  });
  return {
    store,
    deps,
    clock,
    nextId,
    conversations,
    flash,
    pro,
    flashRoom,
    proRoom,
    groupRoom: group.value.data,
    provider,
    service: new RoomBroadcastService(deps),
  };
}

export function history(f: ReturnType<typeof imageChatFixture>, roomId: string) {
  const result = f.conversations.history('ws_ocean', roomId);
  if (!result.ok) throw Error('history');
  return result.value;
}
