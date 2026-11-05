import { LOCAL_MODEL_CONNECTIONS } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { OPENAI_ORIGIN, OPENAI_MODELS } from '@runnets/provider-openai';
import { ANTHROPIC_ORIGIN, ANTHROPIC_MODELS } from '@runnets/provider-anthropic';
import { DEEPSEEK_MODELS } from '@runnets/provider-deepseek';
import type { ModelCommand, ModelPreset } from '../model-protocol.js';
// Proposed inputs only. Existing connection catalogs and all writes remain runtime authority.
const presets: readonly ModelPreset[] = [
  {
    providerId: 'deepseek',
    kind: 'cloud',
    endpoint: 'https://api.deepseek.com',
    models: [...DEEPSEEK_MODELS],
  },
  { providerId: 'openai', kind: 'cloud', endpoint: OPENAI_ORIGIN, models: [...OPENAI_MODELS] },
  {
    providerId: 'anthropic',
    kind: 'cloud',
    endpoint: ANTHROPIC_ORIGIN,
    models: [...ANTHROPIC_MODELS],
  },
  {
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    models: ['qwen3:1.7b'],
  },
];
export function dispatchModelSettings(client: LocalRuntimeClient, c: ModelCommand) {
  if (c.op === 'model-support')
    return { connections: client.identity.capabilities.includes(LOCAL_MODEL_CONNECTIONS) };
  if (!client.identity.capabilities.includes(LOCAL_MODEL_CONNECTIONS))
    throw Error('model_runtime_upgrade_required');
  switch (c.op) {
    case 'model-presets':
      return structuredClone(presets);
    case 'model-connections':
      return client.listModelConnections(c.input);
    case 'model-set':
      return client.setModelConnection(c.input);
    case 'model-check':
      return client.checkModelConnection(c.input);
    case 'model-disconnect':
      return client.disconnectModelConnection(c.input);
    case 'model-remove-key':
      return client.removeModelConnectionKey(c.input);
    case 'bot-bound-create':
      return client.createBoundBot(c.input);
    case 'bot-binding-set':
      return client.setBotModelBinding(c.input);
    case 'bound-bots':
      return client.listBoundBots(c.input);
    case 'model-execution':
      return client.getRunModelExecution(c.input);
  }
}
