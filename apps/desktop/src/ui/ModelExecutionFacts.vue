<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { call } from './bridge.js';
import { modelSupport } from './model-support.js';
import { modelExecutionLines } from './model-execution-text.js';
import { settingsError } from './model-settings-text.js';
const props = defineProps<{ roomId: string; runId: string }>();
const lines = ref<string[]>([]),
  message = ref(''),
  busy = ref(false);
let generation = 0;
watch(
  () => [props.roomId, props.runId],
  () => {
    ++generation;
    lines.value = [];
    message.value = '';
    busy.value = false;
  },
);
onBeforeUnmount(() => {
  ++generation;
});
async function load() {
  if (busy.value || modelSupport.value !== true) return;
  const token = ++generation,
    roomId = props.roomId,
    runId = props.runId;
  busy.value = true;
  try {
    const report = await call({
      op: 'model-execution',
      input: { workspaceId: 'ws_ocean', roomId, runId },
    });
    if (report.workspaceId !== 'ws_ocean' || report.roomId !== roomId || report.runId !== runId)
      throw Error('invalid_frame');
    if (token === generation) {
      lines.value = modelExecutionLines(report);
      message.value = '';
    }
  } catch (error) {
    if (token === generation) message.value = settingsError(error);
  } finally {
    if (token === generation) busy.value = false;
  }
}
</script>
<template>
  <button v-if="modelSupport === true" :disabled="busy" @click="load">
    {{ busy ? 'Читаем…' : 'Показать факты модели этого запуска' }}
  </button>
  <p v-else class="muted">Факты исполнения модели недоступны на этом хосте.</p>
  <p v-for="line in lines" :key="line" class="muted">{{ line }}</p>
  <p v-if="message" role="status">{{ message }}</p>
</template>
