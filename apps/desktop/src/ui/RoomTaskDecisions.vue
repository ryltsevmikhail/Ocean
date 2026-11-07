<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import type { LocalDecision, LocalDecisionRef } from '@runnets/contracts';
import type { RoomTasksState } from './room-task-state.js';
import { taskDecisionScope } from './room-task-decision-scope.js';
import { createServiceDecisions, decisionStatusText } from './service-decisions.js';
const props = defineProps<{ state: RoomTasksState; refs: readonly LocalDecisionRef[] }>();
const other = ref<LocalDecision | null>(null),
  error = ref('');
let epoch = 0;
const scope = taskDecisionScope(props.state);
const scopedRequest = scope.request;
const decisions = createServiceDecisions(scopedRequest);
const { current, preview, message, busy, canResolve } = decisions;
decisions.context(props.state.room.value);
async function inspect(input: LocalDecisionRef) {
  const token = ++epoch;
  other.value = null;
  error.value = '';
  decisions.close();
  try {
    const card = await scopedRequest({ op: 'service-decision', input });
    if (token !== epoch) return;
    if (
      card.roomId !== input.roomId ||
      card.runId !== input.runId ||
      card.decisionId !== input.decisionId
    )
      throw Error('invalid_frame');
    if (card.kind === 'service-call') await decisions.inspect(card);
    else other.value = card;
  } catch (e) {
    if (token === epoch) error.value = String(e instanceof Error ? e.message : e);
  }
}
const timer = setInterval(decisions.tick, 1000);
onBeforeUnmount(() => {
  ++epoch;
  scope.close();
  clearInterval(timer);
  decisions.close();
});
</script>
<template>
  <section v-if="refs.length || current || other || message || error">
    <h3>Решения выбранного корня</h3>
    <button
      v-for="item in refs"
      :key="`${item.runId}/${item.decisionId}`"
      :disabled="busy || state.stale.value"
      @click="inspect(item)"
    >
      {{ item.runId }} · {{ item.decisionId }}
    </button>
    <section v-if="current" class="info-card">
      <p>
        {{ current.runId }} / {{ current.decisionId }} · v{{ current.version }} ·
        {{ decisionStatusText[current.status] }} · {{ current.bindingDigest }}
      </p>
      <pre>{{ preview }}</pre>
      <button :disabled="!canResolve || state.stale.value" @click="decisions.resolve('allow-once')">
        Разрешить один раз
      </button>
      <button :disabled="!canResolve || state.stale.value" @click="decisions.resolve('deny')">
        Отказать
      </button>
      <p>Решение не доказывает завершение эффекта.</p>
    </section>
    <p v-if="other">
      {{ other.kind }} · {{ other.decisionId }} · {{ decisionStatusText[other.status] }}. Только
      чтение: используйте поддерживаемый интерфейс владельца Ocean CLI/TUI для этого вида решения.
    </p>
    <p v-if="message || error" role="status">{{ message || error }}</p>
  </section>
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 24rem;
  overflow: auto;
}
</style>
