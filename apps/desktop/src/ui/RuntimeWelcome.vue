<script setup lang="ts">
import { ref } from 'vue';
import Avatar from './Avatar.vue';
defineProps<{ busy: boolean; ready: boolean; loading: boolean }>();
defineEmits<{ refresh: []; profile: []; team: [] }>();
const copied = ref(false);
const copyError = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText('ocean runtime start');
    copied.value = true;
    copyError.value = false;
  } catch {
    copyError.value = true;
  }
}
</script>
<template>
  <section id="welcome">
    <p v-if="loading" role="status">Загружаем профиль…</p>
    <template v-else-if="!ready">
      <div role="alert" class="runtime-error">
        <h2>Runtime недоступен</h2>
        <p>Запустите runtime для выбранного профиля:</p>
        <code>ocean runtime start</code>
      </div>
      <div class="form-actions">
        <button @click="copy">Скопировать</button>
        <button :disabled="busy" @click="$emit('refresh')">Проверить снова</button>
      </div>
      <p v-if="copied" role="status">Команда скопирована</p>
      <p v-if="copyError" role="alert" class="runtime-error">
        Не удалось скопировать команду. Выделите её и скопируйте вручную.
      </p>
    </template>
    <template v-else>
      <Avatar /><small>ЛОКАЛЬНЫЙ ПРОФИЛЬ</small>
      <h2>Начните с Ocean Team</h2>
      <p>Обсудите задачу с dev, затем передайте результат review в той же комнате.</p>
      <div class="form-actions">
        <button :disabled="busy" @click="$emit('profile')">Проверить профиль</button>
        <button class="primary" :disabled="busy" @click="$emit('team')">Создать Ocean Team</button>
      </div>
    </template>
  </section>
</template>
