<script setup lang="ts">
import { ref, watch } from 'vue';
import type {
  LocalBoundBot,
  LocalBotModelBinding,
  LocalModelConnectionMetadata,
} from '../model-protocol.js';
import ModelBindingPicker from './ModelBindingPicker.vue';
const props = defineProps<{
  snapshot: LocalBoundBot;
  connections: readonly LocalModelConnectionMetadata[];
  disabled: boolean;
  message: string;
  uncertain: boolean;
}>();
const emit = defineEmits<{ save: [binding: LocalBotModelBinding]; recover: [] }>();
const binding = ref<LocalBotModelBinding>({ connectionId: '', modelId: '' });
watch(
  () => props.snapshot,
  (item) => {
    binding.value = item.binding ? { ...item.binding } : { connectionId: '', modelId: '' };
  },
  { immediate: true },
);
</script>
<template>
  <section class="info-card">
    <strong>@{{ snapshot.bot.handle }} · профиль {{ snapshot.bot.profileVersion }}</strong>
    <p>
      Текущая привязка: {{ snapshot.binding?.connectionId ?? 'не записана' }} /
      {{ snapshot.binding?.modelId ?? 'не записана' }}
    </p>
    <ModelBindingPicker
      v-model="binding"
      :connections="connections"
      :disabled="disabled || uncertain"
    />
    <p v-if="message" role="status">{{ message }}</p>
    <button
      :disabled="disabled || uncertain || !binding.connectionId || !binding.modelId"
      @click="emit('save', { ...binding })"
    >
      Сохранить только этого бота
    </button>
    <button v-if="uncertain" :disabled="disabled" @click="emit('recover')">
      Явно повторить исходную привязку с тем же запросом
    </button>
  </section>
</template>
