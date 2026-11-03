<script setup lang="ts">
import { ref } from 'vue';
import type { Run } from '../protocol.js';
import Glyph from './Glyph.vue';
defineProps<{ runs: Run[] }>();
const page = ref<'Задачи комнаты' | 'События' | 'Изменения'>('Задачи комнаты'),
  panel = ref<HTMLDialogElement>();
const entries = [
  ['Задачи комнаты', 'task'],
  ['События', 'event'],
  ['Изменения', 'diff'],
] as const;
</script>
<template>
  <h3>Работа с кодом</h3>
  <button
    v-for="[name, icon] in entries"
    :key="name"
    class="work-link"
    @click="
      page = name;
      panel?.showModal();
    "
  >
    <Glyph :name="icon" />{{ name }}
  </button>
  <dialog ref="panel" class="room-work" :aria-label="page">
    <header>
      <small>РАБОТА С КОДОМ</small
      ><button class="round" aria-label="К разговору" @click="panel?.close()">
        <Glyph name="close" />
      </button>
    </header>
    <h2>{{ page }}</h2>
    <template v-if="page === 'Задачи комнаты'"
      ><p v-if="!runs.length">В этой комнате ещё нет запусков.</p>
      <details v-for="run in runs" :key="run.runId" class="info-card">
        <summary>
          <strong>{{ run.runId }}</strong
          ><span>{{ run.turnStatus ?? run.taskStatus }}</span>
        </summary>
        <dl class="runtime-facts">
          <dt>Состояние задачи</dt>
          <dd>{{ run.taskStatus }}</dd>
          <dt>Версия</dt>
          <dd>{{ run.version }}</dd>
          <dt>Исполнитель</dt>
          <dd>{{ run.performerId }}</dd>
          <dt>Ожидают решения в TUI</dt>
          <dd>{{ run.pendingDecisionIds.join(', ') || '—' }}</dd>
        </dl>
        <p v-if="run.turnStatus === 'uncertain'">
          Исход не подтверждён. Проверьте эффекты этого запуска в Ocean CLI перед продолжением.
        </p>
      </details></template
    >
    <p v-else>
      {{
        page === 'События'
          ? 'Журнал событий доступен в терминале. Desktop пока получает только состояние запуска.'
          : 'Для просмотра изменений, результатов тестов и подтверждения правок нужен проверенный интерфейс задач Ocean 1.1.'
      }}
    </p>
  </dialog>
</template>
