import type { ConversationService, ProviderPort } from '@runnets/application';

export function rooms(conversations: ConversationService) {
  const workspaceId = 'ws_ocean';
  const execute = conversations.execute.bind(conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId, root: '/fixture' });
  const bots = ['dev', 'ops'].map((handle) => {
    const result = execute({
      type: 'CreateBot',
      workspaceId,
      requestId: handle,
      handle,
      name: handle,
      role: 'fixture role',
      provider: 'test',
      model: 'test',
    });
    if (!result.ok || result.value.kind !== 'bot') throw Error('fixture bot');
    return result.value.data.id;
  });
  const direct = execute({
    type: 'OpenDirectRoom',
    workspaceId,
    requestId: 'direct',
    botId: bots[0]!,
  });
  const group = execute({
    type: 'CreateGroupRoom',
    workspaceId,
    requestId: 'group',
    title: 'team',
    botIds: bots,
  });
  if (!direct.ok || direct.value.kind !== 'room' || !group.ok || group.value.kind !== 'room')
    throw Error('fixture rooms');
  return {
    workspaceId,
    roomId: direct.value.data.id,
    groupId: group.value.data.id,
    requestId: 'submit',
    text: 'hello',
  };
}
export function gatedProvider(
  wait: () => Promise<void>,
  entered: (signal: AbortSignal) => void,
): ProviderPort {
  return {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream(request) {
      entered(request.signal!);
      await wait();
      yield { type: 'text_delta', text: 'fixture answer' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
