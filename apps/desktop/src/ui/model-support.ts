import { ref } from 'vue';
import { call } from './bridge.js';
import { connectionSettings } from './model-connection-state.js';
import { botModels } from './bot-model-state.js';
import { loadProviderStatus } from './provider-state.js';
export const modelSupport = ref<boolean | null>(null);
export const modelSupportVersion = ref(0);
export async function readModelSupport(): Promise<boolean> {
  const version = ++modelSupportVersion.value;
  modelSupport.value = null;
  const support = await call({ op: 'model-support' });
  if (version !== modelSupportVersion.value) throw Error('model_support_changed');
  modelSupport.value = support.connections;
  return support.connections;
}

export async function refreshModelSettings(): Promise<void> {
  if (await readModelSupport()) await Promise.all([connectionSettings.load(), botModels.load()]);
  else await loadProviderStatus();
}

export function pinModelSupport() {
  const supported = modelSupport.value,
    version = modelSupportVersion.value;
  if (supported === null) throw Error('model_support_changed');
  return {
    supported,
    assertCurrent() {
      if (modelSupport.value !== supported || modelSupportVersion.value !== version)
        throw Error('model_support_changed');
    },
  };
}
