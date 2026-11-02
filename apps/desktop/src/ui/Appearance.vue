<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue';
const dialog = ref<HTMLDialogElement>();
const theme = ref(localStorage.getItem('appearance.theme') ?? 'dark');
const color = ref(localStorage.getItem('appearance.color') ?? 'blue');
const avatars = ref(localStorage.getItem('appearance.avatars') !== 'off');
const colors = [
  ['blue', 'Синий'],
  ['teal', 'Бирюзовый'],
  ['purple', 'Фиолетовый'],
] as const;
onMounted(() =>
  watchEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    document.documentElement.dataset.color = color.value;
    document.documentElement.classList.toggle('hide-avatars', !avatars.value);
    localStorage.setItem('appearance.theme', theme.value);
    localStorage.setItem('appearance.color', color.value);
    localStorage.setItem('appearance.avatars', avatars.value ? 'on' : 'off');
  }),
);
</script>
<template>
  <button class="gear" aria-label="Настройки" title="Настройки" @click="dialog?.showModal()">
    ⚙
  </button>
  <dialog ref="dialog" class="settings" aria-labelledby="settings-title">
    <header>
      <h2 id="settings-title">Общие</h2>
      <button class="round" aria-label="Закрыть настройки" @click="dialog?.close()">×</button>
    </header>
    <h3>Внешний вид</h3>
    <div class="settings-rows">
      <label
        >Тема<select v-model="theme">
          <option value="dark">Тёмная</option>
          <option value="light">Светлая</option>
          <option value="system">Как в системе</option>
        </select></label
      >
      <div class="setting">
        <span>Акцент</span>
        <div class="swatches">
          <button
            v-for="[id, title] in colors"
            :key="id"
            :data-swatch="id"
            :aria-label="title"
            :aria-pressed="color === id"
            @click="color = id"
          ></button>
        </div>
      </div>
      <label>Аватары ботов<input v-model="avatars" type="checkbox" role="switch" /></label>
    </div>
  </dialog>
</template>
