<script setup lang="ts">
import { computed } from 'vue';
import type { LocalBotModelBinding, LocalModelConnectionMetadata } from '../model-protocol.js';
const props = defineProps<{
  connections: readonly LocalModelConnectionMetadata[];
  disabled?: boolean;
}>();
const binding = defineModel<LocalBotModelBinding>({ required: true });
const connection = computed(() =>
  props.connections.find((x) => x.connectionId === binding.value.connectionId),
);
function choose(event: Event) {
  binding.value = { connectionId: (event.target as HTMLSelectElement).value, modelId: '' };
}
</script>
<template>
  <label
    >Подключение<select
      :value="binding.connectionId"
      :disabled="disabled"
      required
      @change="choose"
    >
      <option value="" disabled>Выберите явно</option>
      <option v-if="binding.connectionId && !connection" :value="binding.connectionId">
        {{ binding.connectionId }} · недоступно
      </option>
      <option v-for="item in connections" :key="item.connectionId" :value="item.connectionId">
        {{ item.connectionId }} · {{ item.kind }} · {{ item.endpoint }} ·
        {{ item.configuration.intent }}
      </option>
    </select></label
  >
  <label
    >Модель<select v-model="binding.modelId" :disabled="disabled || !connection" required>
      <option value="" disabled>Выберите явно</option>
      <option
        v-if="binding.modelId && !connection?.models.some((x) => x.modelId === binding.modelId)"
        :value="binding.modelId"
      >
        {{ binding.modelId }} · нет в каталоге
      </option>
      <option v-for="item in connection?.models ?? []" :key="item.modelId" :value="item.modelId">
        {{ item.modelId }} · инструменты: {{ item.capabilities.tools ? 'да' : 'нет' }} ·
        изображения: {{ item.capabilities.inputModalities.includes('image') ? 'да' : 'нет' }}
      </option>
    </select></label
  >
  <small v-if="connection?.kind === 'local' && !connection.localQualification" class="warning"
    >Локальная модель ещё не квалифицирована. Выполните явную проверку в настройках
    подключений.</small
  >
  <small v-if="connection?.configuration.intent !== 'active' && connection" class="warning"
    >Состояние {{ connection.configuration.intent }}. Выбор не подтверждает готовность
    модели.</small
  >
</template>
