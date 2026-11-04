import { ConversationService, TaskRunService, type ProviderPort } from '@runnets/application';
import { InMemoryConversationStore, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { activation, instant, terminal, usage } from './model-turn.js';

export function activationFixture() {
  const store = new InMemoryConversationStore();
  let ids = 0;
  const nextId = () => `activation_${++ids}`;
  const clock = { now: () => new Date(instant) };
  const conversations = new ConversationService({ store, nextId, clock });
  conversations.execute({
    type: 'BindWorkspace',
    workspaceId: 'fixture_workspace',
    requestId: 'init',
    root: '/fixture',
  });
  const result = conversations.execute({
    type: 'CreateBot',
    workspaceId: 'fixture_workspace',
    requestId: 'bot',
    handle: 'dev',
    name: 'Dev',
    role: 'fixture',
    provider: 'scripted',
    model: 'scripted',
  });
  if (!result.ok || result.value.kind !== 'bot') throw Error('fixture bot');
  const bot = result.value.data;
  const room = conversations.execute({
    type: 'OpenDirectRoom',
    workspaceId: 'fixture_workspace',
    requestId: 'room',
    botId: bot.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture room');
  const tasks = new TaskRunService({
    log: new InMemoryEventLog(),
    ids: new SequentialIdGenerator(),
    clock,
  });
  let calls = 0;
  const provider: ProviderPort = {
    id: 'scripted',
    models: ['scripted'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream() {
      calls++;
      yield usage;
      yield { type: 'text_delta', text: 'answer' };
      yield terminal;
    },
  };
  let resolutions = 0;
  const snapshot = activation();
  const resolver = {
    resolve: () => {
      resolutions++;
      return { ok: true as const, value: { provider, snapshot } };
    },
  };
  const request = {
    workspaceId: 'fixture_workspace',
    roomId: room.value.data.id,
    requestId: 'turn',
    text: 'hello',
    signal: new AbortController().signal,
    emit: () => {},
  };
  return {
    store,
    tasks,
    clock,
    nextId,
    bot,
    provider,
    resolver,
    snapshot,
    request,
    calls: () => calls,
    resolutions: () => resolutions,
  };
}
