<script setup lang="ts">
import { ref } from 'vue';
import Glyph from './Glyph.vue';
import { explain } from './dom.js';
import {
  checkProvider,
  clearProviderInput,
  disconnectProvider,
  loadProviderStatus,
  providerBusy,
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
const panel = ref<HTMLDialogElement>();
function open() {
  clearProviderInput();
  panel.value?.showModal();
  void loadProviderStatus();
}
function close() {
  clearProviderInput();
  panel.value?.close();
}
function capabilities(model: string): string {
  const entry = providerStatus.value?.modelCapabilities.find((item) => item.model === model);
  return providerCapabilitySuffix(entry?.imageInput ?? false);
}
</script>
<template>
  <button class="round" aria-label="Провайдер" title="Провайдер" :disabled="busy" @click="open">
    <Glyph name="provider" />
  </button>
  <Teleport to="body">
    <dialog ref="panel" class="provider-panel" aria-label="Провайдер" @cancel="close">
      <header>
        <small>ПРОВАЙДЕР</small
        ><button class="round" aria-label="Закрыть провайдера" @click="close">
          <Glyph name="close" />
        </button>
      </header>
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
          :disabled="busy || providerBusy || !providerStatus?.writable"
        >
          <option v-for="model in providerModels" :key="model" :value="model">
            {{ model }}{{ capabilities(model) }}
          </option>
        </select></label
      >
      <label
        >Ключ API<input
          v-model="providerKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
          :disabled="busy || providerBusy || !providerStatus?.writable"
          aria-describedby="provider-key-tip" /></label
      ><small id="provider-key-tip" class="muted">{{
        providerKeyHint(providerKey, providerStatus?.savedKey ?? false, providerStatus?.state)
      }}</small>
      <p v-if="providerStatus?.savedKey" class="muted">
        Ocean хранит собственный ключ. Внешний ключ окружения Ocean не изменяет и не удаляет.
        Удаление сохранённого ключа не отзывает его у DeepSeek.
      </p>
      <p
        v-if="providerMessage"
        :role="providerError ? 'alert' : 'status'"
        :class="{ warning: providerError }"
      >
        {{ providerMessage }}
      </p>
      <div class="form-actions">
        <button :disabled="busy || providerBusy" @click="checkProvider">Проверить</button
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
            !providerStatus?.writable ||
            providerStatus.state !== 'connected'
          "
          @click="disconnectProvider"
        >
          Отключить</button
        ><button
          :disabled="busy || providerBusy || !providerStatus?.writable || !providerStatus.savedKey"
          @click="removeSavedProviderKey"
        >
          Удалить сохранённый ключ
        </button>
      </div>
    </dialog>
  </Teleport>
</template>
