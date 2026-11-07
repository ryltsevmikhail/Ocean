<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { LocalDecision } from '@runnets/contracts';
import type { ProjectCard } from '../project-protocol.js';
import { decisionStatusText } from './service-decisions.js';
import { projectDecisionText, projectError } from './project-state.js';

const props = defineProps<{
  title: string;
  inspect: () => Promise<ProjectCard>;
  resolve: (input: {
    choice: 'allow-once' | 'deny';
    expectedVersion: number;
    bindingDigest: string;
  }) => Promise<LocalDecision>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ decided: [] }>();
const card = ref<ProjectCard | null>(null);
const result = ref<LocalDecision | null>(null);
const error = ref('');
const busy = ref(false);
const now = ref(Date.now());
let alive = true;
const timer = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => {
  alive = false;
  clearInterval(timer);
});
const canVote = computed(
  () =>
    !busy.value &&
    !props.disabled &&
    !result.value &&
    card.value?.decision.status === 'pending' &&
    card.value.decision.expiresAt > now.value,
);
async function inspect() {
  busy.value = true;
  card.value = null;
  result.value = null;
  error.value = '';
  try {
    const value = await props.inspect();
    if (alive) card.value = value;
  } catch (e) {
    error.value = projectError(e);
  } finally {
    busy.value = false;
  }
}
async function decide(choice: 'allow-once' | 'deny') {
  if (!canVote.value || !card.value) return;
  const { version, bindingDigest } = card.value.decision;
  busy.value = true;
  card.value = null;
  error.value = '';
  try {
    result.value = await props.resolve({ choice, expectedVersion: version, bindingDigest });
  } catch (e) {
    error.value = projectError(e);
  } finally {
    busy.value = false;
    if (alive) emit('decided');
  }
}
</script>
<template>
  <section class="project-decision">
    <div class="project-row">
      <strong>{{ title }}</strong>
      <button type="button" :disabled="busy || disabled" @click="inspect">
        {{ busy ? 'Чтение…' : 'Открыть карточку' }}
      </button>
    </div>
    <template v-if="card">
      <p class="muted">
        Версия {{ card.decision.version }} · {{ decisionStatusText[card.decision.status] }}
      </p>
      <p class="muted project-hash">{{ card.decision.bindingDigest }}</p>
      <pre tabindex="0">{{ projectDecisionText(card.preview) }}</pre>
      <div v-if="card.decision.status === 'pending'" class="project-row">
        <button
          type="button"
          class="project-primary"
          :disabled="!canVote"
          @click="decide('allow-once')"
        >
          Разрешить один раз
        </button>
        <button type="button" :disabled="!canVote" @click="decide('deny')">Отказать</button>
      </div>
    </template>
    <p v-if="result" role="status">
      Решение: {{ decisionStatusText[result.status] }}. Проверьте результат операции отдельно.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
