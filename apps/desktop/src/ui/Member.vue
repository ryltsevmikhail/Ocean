<script setup lang="ts">
import { ref, computed } from 'vue';
import Avatar from './Avatar.vue';
import { botStyle, setBotStyle, shapes, colors } from './bot-style.js';
import type { Bot } from '../protocol.js';
const props = defineProps<{ bot: Bot }>();
const editor = ref<HTMLDialogElement>();
const style = computed(() => botStyle(props.bot.handle));
const names = { dev: 'Квадрат', review: 'Галька', docs: 'Клевер' };
const labels = ['Синий', 'Янтарный', 'Зелёный', 'Фиолетовый', 'Розовый', 'Белый'];
</script>
<template>
  <button class="person" :aria-label="'Аватар @' + bot.handle" @click="editor?.showModal()">
    <Avatar :handle="bot.handle" /><span
      ><strong>@{{ bot.handle }}</strong
      ><small>{{ bot.name }}</small></span
    >
  </button>
  <dialog ref="editor" class="settings" :aria-label="'Аватар @' + bot.handle">
    <header>
      <h2>Аватар @{{ bot.handle }}</h2>
      <button class="round" aria-label="Закрыть" @click="editor?.close()">×</button>
    </header>
    <div class="avatar-preview"><Avatar :handle="bot.handle" preview /></div>
    <h3>Форма</h3>
    <div class="shapes">
      <button
        v-for="shape in shapes"
        :key="shape"
        :aria-label="names[shape]"
        :aria-pressed="style.shape === shape"
        @click="setBotStyle(bot.handle, { ...style, shape })"
      >
        <Avatar :shape="shape" :color="style.color" preview />
      </button>
    </div>
    <h3>Цвет</h3>
    <div class="swatches bot-colors">
      <button
        v-for="(color, i) in colors"
        :key="color"
        :aria-label="labels[i]"
        :aria-pressed="style.color === color"
        @click="setBotStyle(bot.handle, { ...style, color })"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="10" :fill="color" />
        </svg>
      </button>
    </div>
    <button @click="setBotStyle(bot.handle, null)">Сбросить</button>
  </dialog>
</template>
