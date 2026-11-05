<script setup lang="ts">
import {
  providerPending,
  providerMessage,
  providerError,
  providerBusy,
  providerStale,
  providerKey,
  providerStatus,
  loadProviderStatus,
  recoverProvider,
} from './provider-state.js';
defineProps<{ busy: boolean; legacy?: boolean }>();
</script>
<template>
  <p v-if="legacy && !providerPending && providerStatus?.state === 'unverified'" role="status">
    Точный исторический ввод в этом окне отсутствует. Старый хост не публикует описание
    восстановления; окно не может автоматически восстановить исходную операцию.
  </p>
  <section v-if="providerPending" class="info-card warning" role="status">
    <p>
      Исход старой provider-операции неизвестен. Новый запрос не создаётся. Текущее состояние не
      доказывает её завершение.
    </p>
    <pre>{{ JSON.stringify(providerPending.command, null, 2) }}</pre>
    <p v-if="providerMessage" :role="providerError ? 'alert' : 'status'">{{ providerMessage }}</p>
    <label v-if="providerPending.requiresKey"
      >Тот же исходный ключ<input
        v-model="providerKey"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy || providerBusy"
    /></label>
    <p v-if="providerStale">Требуется успешное чтение текущих метаданных.</p>
    <button :disabled="busy || providerBusy" @click="loadProviderStatus">
      Обновить метаданные
    </button>
    <button
      :disabled="busy || providerBusy || providerStale || !providerStatus?.writable"
      @click="recoverProvider"
    >
      Явно завершить точную исходную операцию
    </button>
  </section>
</template>
