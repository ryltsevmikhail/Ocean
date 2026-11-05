import { ref } from 'vue';
import { call } from './bridge.js';
import { connectionSettings } from './model-connection-state.js';
import { botModels } from './bot-model-state.js';
import { loadProviderStatus } from './provider-state.js';
export const modelSupport = ref<boolean | null>(null);
export async function readModelSupport(): Promise<boolean> {
  modelSupport.value = null;
  const support = await call({ op: 'model-support' });
  modelSupport.value = support.connections;
  return support.connections;
}

export async function refreshModelSettings(): Promise<void> {
  if (await readModelSupport()) await Promise.all([connectionSettings.load(), botModels.load()]);
  else await loadProviderStatus();
}
