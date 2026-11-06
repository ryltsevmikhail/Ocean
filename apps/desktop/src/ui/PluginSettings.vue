<script setup lang="ts">
import { ref, watch } from 'vue';
import Glyph from './Glyph.vue';
import LegacyPluginSettings from './LegacyPluginSettings.vue';
import ServiceConnectionForm from './ServiceConnectionForm.vue';
import ServiceGrantForm from './ServiceGrantForm.vue';
import ServiceDecisions from './ServiceDecisions.vue';
import ServiceArchive from './ServiceArchive.vue';
import { call } from './bridge.js';
import { createServiceSettings } from './service-settings-state.js';
import type { Bot, Room, Run } from '../protocol.js';
const props = defineProps<{
  busy: boolean;
  room?: Room | undefined;
  bots: readonly Bot[];
  runs?: readonly Run[];
}>();
const panel = ref<HTMLDialogElement>(),
  state = createServiceSettings();
const mode = ref<'loading' | 'current' | 'historical' | 'error'>('loading'),
  historical = ref(false),
  decisions = ref(false),
  message = ref(''),
  opened = ref(false);
let epoch = 0;
watch([() => props.room?.id, () => state.botId.value], () => {
  state.context(props.room?.id ?? '', state.botId.value);
  if (opened.value && mode.value === 'current') void state.load();
});
async function open() {
  panel.value?.showModal();
  opened.value = true;
  mode.value = 'loading';
  message.value = '';
  const token = ++epoch;
  state.context(props.room?.id ?? '', '');
  try {
    const support = await call({ op: 'service-support' });
    if (token !== epoch) return;
    historical.value = support.historical;
    decisions.value = support.decisions;
    if (support.current) {
      mode.value = 'current';
      await state.load();
    } else if (support.historicalOnly) mode.value = 'historical';
    else {
      mode.value = 'error';
      message.value =
        'Runtime не поддерживает сервисы или исторический протокол. Требуется обновление.';
    }
  } catch (e) {
    if (token === epoch) {
      mode.value = 'error';
      message.value =
        'Не удалось согласовать возможности: ' + String(e instanceof Error ? e.message : e);
    }
  }
}
function close() {
  ++epoch;
  opened.value = false;
  state.close();
  panel.value?.close();
}
</script>
<template>
  <button class="round" aria-label="Плагины" title="Плагины" :disabled="busy" @click="open">
    <Glyph name="settings" />
  </button>
  <Teleport to="body"
    ><dialog
      ref="panel"
      class="provider-panel plugin-panel"
      aria-label="Сервисы и плагины"
      @cancel.prevent="close"
      @close="close"
    >
      <header>
        <small>СЕРВИСЫ И РЕШЕНИЯ ВЛАДЕЛЬЦА</small
        ><button class="round" aria-label="Закрыть сервисы" @click="close">
          <Glyph name="close" />
        </button>
      </header>
      <p v-if="mode === 'loading'" role="status">Согласование возможностей runtime…</p>
      <template v-else-if="mode === 'current' && opened">
        <ServiceConnectionForm :state="state" /><ServiceGrantForm
          :state="state"
          :room="room"
          :bots="bots"
        />
        <ServiceDecisions
          v-if="decisions"
          :room-id="room?.id ?? ''"
          :bot-id="state.botId.value"
          :runs="runs ?? []"
        />
        <p v-else role="status">Runtime не поддерживает текущие service-call решения.</p>
        <ServiceArchive :state="state" :supported="historical" />
      </template>
      <template v-else-if="mode === 'historical'"
        ><p role="status">
          Старый runtime: только исторический интерфейс плагинов. Это не текущее выполнение
          сервисов.
        </p>
        <LegacyPluginSettings :busy="busy" :room="room" :bots="bots"
      /></template>
      <p v-else role="alert">{{ message }}</p>
    </dialog></Teleport
  >
</template>

<style scoped>
.plugin-panel {
  min-width: 0;
  overflow-wrap: anywhere;
}
.plugin-panel :deep(*) {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.plugin-panel :deep(button) {
  white-space: normal;
  overflow-wrap: anywhere;
}
.plugin-panel :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
