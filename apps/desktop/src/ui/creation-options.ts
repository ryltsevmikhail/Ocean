import { ref } from 'vue';
import { readModelSupport, pinModelSupport } from './model-support.js';
import { connectionSettings } from './model-connection-state.js';
import { loadProviderStatus, providerDefaultModel, providerStale } from './provider-state.js';
import { settingsError } from './model-settings-text.js';
interface Reads {
  readonly support: () => Promise<boolean>;
  readonly connections: () => Promise<void>;
  readonly legacy: () => Promise<string>;
  readonly pin?: () => { assertCurrent: () => void };
}
const defaults: Reads = {
  pin: pinModelSupport,
  support: readModelSupport,
  connections: () => connectionSettings.load(),
  legacy: async () => {
    await loadProviderStatus();
    if (providerStale.value) throw Error('provider_unavailable');
    return providerDefaultModel.value;
  },
};
/** Only the active dialog open may publish its positively negotiated family/model. */
export function createCreationOptions(read: Reads = defaults) {
  const negotiated = ref<boolean | null>(null),
    model = ref(''),
    message = ref('');
  let generation = 0;
  async function open() {
    const token = ++generation;
    negotiated.value = null;
    model.value = '';
    message.value = '';
    try {
      const supported = await read.support();
      if (token !== generation) return;
      const pinned = read.pin?.();
      const legacy = supported ? (await read.connections(), '') : await read.legacy();
      if (token !== generation) return;
      pinned?.assertCurrent();
      model.value = legacy;
      negotiated.value = supported;
    } catch (error) {
      if (token === generation) message.value = settingsError(error);
    }
  }
  function close() {
    ++generation;
    negotiated.value = null;
    model.value = '';
  }
  return { negotiated, model, message, open, close };
}
