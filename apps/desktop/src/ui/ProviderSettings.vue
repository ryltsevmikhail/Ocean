<script setup lang="ts">
import { ref } from 'vue';
import Glyph from './Glyph.vue';
import LegacyProviderSettings from './LegacyProviderSettings.vue';
import ConnectionSettings from './ConnectionSettings.vue';
import { clearProviderInput, loadProviderStatus } from './provider-state.js';
import { readModelSupport } from './model-support.js';
import { settingsError } from './model-settings-text.js';
defineProps<{ busy: boolean }>();
const panel = ref<HTMLDialogElement>(),
  connections = ref<InstanceType<typeof ConnectionSettings>>();
const mode = ref<'loading' | 'model' | 'legacy' | 'error'>('loading'),
  message = ref('');
let generation = 0;
async function open() {
  clearProviderInput();
  panel.value?.showModal();
  mode.value = 'loading';
  message.value = '';
  const token = ++generation;
  try {
    const supported = await readModelSupport();
    if (token !== generation) return;
    mode.value = supported ? 'model' : 'legacy';
    if (!supported) await loadProviderStatus();
  } catch (error) {
    if (token === generation) {
      mode.value = 'error';
      message.value = settingsError(error);
    }
  }
}
function close() {
  ++generation;
  clearProviderInput();
  connections.value?.clear();
  panel.value?.close();
}
</script>
<template>
  <button class="round" aria-label="Провайдер" title="Провайдер" :disabled="busy" @click="open">
    <Glyph name="provider" />
  </button>
  <Teleport to="body"
    ><dialog
      ref="panel"
      class="provider-panel"
      aria-label="Провайдер"
      @cancel.prevent="close"
      @close="
        clearProviderInput();
        connections?.clear();
      "
    >
      <header>
        <small>ПРОВАЙДЕР</small
        ><button class="round" aria-label="Закрыть провайдера" @click="close">
          <Glyph name="close" />
        </button>
      </header>
      <p v-if="mode === 'loading'" role="status">Читаем возможности хоста…</p>
      <ConnectionSettings v-else-if="mode === 'model'" ref="connections" :disabled="busy" />
      <LegacyProviderSettings v-else-if="mode === 'legacy'" :busy="busy" />
      <p v-else role="alert">{{ message }}</p>
    </dialog></Teleport
  >
</template>
