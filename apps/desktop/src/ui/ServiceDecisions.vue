<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue';
import { createServiceDecisions, decisionStatusText } from './service-decisions.js';
import { turnText } from './runtime-text.js';
import type { Run } from '../protocol.js';
const props = defineProps<{ roomId: string; botId: string; runs: readonly Run[] }>();
const state = createServiceDecisions();
const { cards, current, preview, message, busy, canResolve, cursor, exhausted, reading } = state;
const run = computed(() =>
  props.runs.find((r) => r.roomId === props.roomId && r.runId === current.value?.runId),
);
watch(
  [() => props.roomId, () => props.botId],
  () => {
    state.context(props.roomId);
    void state.load();
  },
  { immediate: true },
);
const timer = setInterval(state.tick, 1000);
onBeforeUnmount(() => {
  clearInterval(timer);
  state.close();
});
</script>
<template>
  <h2>Решения владельца: вызовы сервисов</h2>
  <button data-testid="service-decisions-reload" :disabled="busy || reading" @click="state.load">
    Перечитать решения
  </button>
  <p v-if="cursor" role="status">
    Прочитана ограниченная часть списка; отсутствие карточек здесь не означает, что решений больше
    нет.
  </p>
  <button
    v-if="cursor"
    data-testid="service-decisions-more"
    :disabled="busy || reading"
    @click="state.loadMore"
  >
    Показать следующую часть решений
  </button>
  <p v-if="exhausted && !cards.length" role="status">
    Список прочитан полностью; вызовов сервисов нет.
  </p>
  <p v-if="!roomId">Выберите комнату.</p>
  <ul>
    <li v-for="card in cards" :key="card.decisionId">
      <button data-testid="service-decision-card" :disabled="busy" @click="state.inspect(card)">
        {{ card.roomId }} / {{ card.runId }} · {{ card.decisionId }} ·
        {{ decisionStatusText[card.status] }} · v{{ card.version }}
      </button>
    </li>
  </ul>
  <section v-if="current" class="info-card" data-testid="service-decision-detail">
    <p>
      {{ current.roomId }} / {{ current.runId }} · {{ decisionStatusText[current.status] }} ·
      {{ current.bindingDigest }}
    </p>
    <p v-if="run" data-testid="service-run-facts">
      Исполнитель: {{ run.performerId }} · ход: {{ turnText[run.turnStatus] }} · задача:
      {{ run.taskStatus }}. Факт результата запуска:
      {{
        run.resultMessageId
          ? 'ответ в истории: ' + run.resultMessageId
          : 'завершение не подтверждено'
      }}.
    </p>
    <p v-else>Факты исполнителя и результата запуска ещё не прочитаны; они неизвестны.</p>
    <pre data-testid="service-decision-preview">{{ preview }}</pre>
    <button
      data-testid="service-decision-allow"
      :disabled="!canResolve"
      @click="state.resolve('allow-once')"
    >
      Разрешить один раз</button
    ><button
      data-testid="service-decision-deny"
      :disabled="!canResolve"
      @click="state.resolve('deny')"
    >
      Отказать
    </button>
    <small
      >Показана полная операция с проверкой SHA256. Разрешение — факт решения, не факт завершения
      эффекта. Закрытие окна не отменяет запуск.</small
    >
  </section>
  <p v-if="message" role="status">{{ message }}</p>
</template>
<style scoped>
pre {
  max-height: 20rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
