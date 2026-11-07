<script setup lang="ts">
import {
  providerPending,
  providerRecoverySupported,
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
  <section
    v-if="providerPending && (legacy || providerRecoverySupported)"
    class="info-card warning"
    role="status"
  >
    <p>
      Исход операции этого подключения неизвестен. Новый запрос не создаётся. Текущее состояние не
      доказывает её завершение.
    </p>
    <pre>{{ JSON.stringify(providerPending.command, null, 2) }}</pre>
    <p v-if="!providerRecoverySupported">
      Старый хост не поддерживает точное семейство этой modelConnections-операции. Завершите её на
      совместимом хосте; другой provider-запрос для этого подключения заблокирован.
    </p>
    <p v-if="providerMessage" :role="providerError ? 'alert' : 'status'">{{ providerMessage }}</p>
    <label v-if="providerPending.requiresKey && providerRecoverySupported"
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
      :disabled="
        busy ||
        providerBusy ||
        providerStale ||
        !providerStatus?.writable ||
        !providerRecoverySupported
      "
      @click="recoverProvider"
    >
      Явно завершить точную исходную операцию
    </button>
  </section>
</template>
