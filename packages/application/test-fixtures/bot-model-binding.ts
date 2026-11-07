import {
  BotModelBindingService,
  ConversationService,
  unconfiguredModelConnection,
  type ConversationStore,
  type ModelConnectionStorePort,
  type ModelCredentialFactory,
} from '@runnets/application';
import { InMemoryConversationStore } from '@runnets/store';

export const createBinding = {
  workspaceId: 'w',
  requestId: 'create',
  handle: 'dev',
  name: 'Developer',
  role: 'Any freeform role: help write and review',
  binding: { connectionId: 'shared', modelId: 'one' },
};
export function bindingFixture(
  store: ConversationStore = new InMemoryConversationStore(),
  connections: ModelConnectionStorePort = store as InMemoryConversationStore,
) {
  let id = 0;
  let models = ['one', 'two'];
  const factory: ModelCredentialFactory = {
    catalog: () =>
      models.map((modelId) => ({
        modelId,
        capabilities: {
          tools: true,
          streaming: true,
          inputModalities: ['text'],
          contextTokens: null,
          maxOutputTokens: null,
          usage: 'optional',
        },
      })),
    activate: () => {
      throw Error('must not activate');
    },
    external: () => {
      throw Error('must not resolve external credentials');
    },
  };
  const nextId = () => `bot_${++id}`;
  const old = new ConversationService({ store, nextId, clock: { now: () => new Date(0) } });
  old.execute({ type: 'BindWorkspace', workspaceId: 'w', requestId: 'init', root: '/project' });
  connections.put(
    {
      ...unconfiguredModelConnection('deepseek'),
      connectionId: 'shared',
      legacyEnvironment: false,
      defaultModelId: 'one',
      intent: 'disconnected',
      revision: 1,
    },
    null,
  );
  const service = new BotModelBindingService({ store, connections, factory, nextId });
  return {
    store,
    connections,
    factory,
    old,
    service,
    models: (value: string[]) => {
      models = value;
    },
  };
}
