<script setup lang="ts">
import LegacyProviderRecovery from './LegacyProviderRecovery.vue';
import { explain } from './dom.js';
import {
  checkProvider,
  disconnectProvider,
  providerBusy,
  providerPending,
  providerStale,
  providerCanSave,
  providerError,
  providerKey,
  providerMessage,
  providerModel,
  providerModels,
  providerStatus,
  removeSavedProviderKey,
  saveProvider,
} from './provider-state.js';
import {
  providerCapabilitySuffix,
  providerCheckLine,
  providerKeyHint,
  providerStatusLine,
} from './provider-text.js';

defineProps<{ busy: boolean }>();
function capabilities(model: string): string {
  const entry = providerStatus.value?.modelCapabilities.find((item) => item.model === model);
  return providerCapabilitySuffix(entry?.imageInput ?? false);
}
</script>
<template>
  <h2>DeepSeek</h2>
  <p v-if="!providerStatus" role="status">Проверяем подключение…</p>
  <section v-else class="info-card" role="status" :data-state="providerStatus.state">
    <strong>{{ providerStatusLine(providerStatus) }}</strong>
    <p v-if="providerStatus.lastCheck" class="check-line">
      {{ providerCheckLine(providerStatus.lastCheck, providerStatus) }}
    </p>
    <p v-if="providerStatus.code">{{ explain(providerStatus.code) }}</p>
    <p v-if="!providerStatus.writable">Изменение недоступно: профиль только для чтения.</p>
  </section>
  <label
    >Модель<select
      v-model="providerModel"
      :disabled="
        busy || providerBusy || !!providerPending || providerStale || !providerStatus?.writable
      "
    >
      <option v-for="model in providerModels" :key="model" :value="model">
        {{ model }}{{ capabilities(model) }}
      </option>
    </select></label
  >
  <label v-if="!providerPending"
    >Ключ API<input
      v-model="providerKey"
      type="password"
      autocomplete="off"
      spellcheck="false"
      placeholder="sk-…"
      :disabled="
        busy || providerBusy || !!providerPending || providerStale || !providerStatus?.writable
      "
      aria-describedby="provider-key-tip" /></label
  ><small id="provider-key-tip" class="muted">{{
    providerKeyHint(providerKey, providerStatus?.savedKey ?? false, providerStatus?.state)
  }}</small>
  <p v-if="providerStatus?.savedKey" class="muted">
    Ocean хранит собственный ключ. Внешний ключ окружения Ocean не изменяет и не удаляет. Удаление
    сохранённого ключа не отзывает его у DeepSeek.
  </p>
  <p
    v-if="providerMessage && !providerPending"
    :role="providerError ? 'alert' : 'status'"
    :class="{ warning: providerError }"
  >
    {{ providerMessage }}
  </p>
  <LegacyProviderRecovery :busy="busy" :legacy="true" />
  <div class="form-actions">
    <button :disabled="busy || providerBusy || !!providerPending" @click="checkProvider">
      Проверить</button
    ><button
      class="primary"
      :disabled="busy || providerBusy || !providerCanSave"
      @click="saveProvider"
    >
      {{ providerStatus?.savedKey ? 'Заменить' : 'Сохранить' }}</button
    ><button
      :disabled="
        busy ||
        providerBusy ||
        !!providerPending ||
        providerStale ||
        !providerStatus?.writable ||
        providerStatus.state !== 'connected'
      "
      @click="disconnectProvider"
    >
      Отключить</button
    ><button
      :disabled="
        busy ||
        providerBusy ||
        !!providerPending ||
        providerStale ||
        !providerStatus?.writable ||
        !providerStatus.savedKey
      "
      @click="removeSavedProviderKey"
    >
      Удалить сохранённый ключ
    </button>
  </div>
</template>
