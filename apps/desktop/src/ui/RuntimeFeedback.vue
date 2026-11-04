<script setup lang="ts">
import { receiptLabel, runText } from './runtime-text.js';
import type { Run } from '../protocol.js';
defineProps<{
  feedback: string;
  receipt: string;
  accepted?: boolean;
  error: boolean;
  run: Run | undefined;
  label: (id: string) => string;
}>();
defineEmits<{ refresh: [] }>();
</script>
<template>
  <div id="feedback">
    <div v-if="feedback && error" role="alert" class="runtime-error">
      {{ feedback }} <button @click="$emit('refresh')">Обновить</button>
    </div>
    <div v-if="run?.turnStatus === 'failed'" role="alert" class="runtime-error">
      {{ runText(run, label(run.performerId)) }}
      <button @click="$emit('refresh')">Обновить</button>
    </div>
    <div role="status">
      <p v-if="feedback && !error">{{ feedback }}</p>
      <p v-if="receipt" :title="receipt">{{ receiptLabel(receipt, accepted) }}</p>
      <p v-if="run && run.turnStatus !== 'failed'" :title="run.runId + ' [v' + run.version + ']'">
        {{ runText(run, label(run.performerId)) }}
      </p>
    </div>
  </div>
</template>
