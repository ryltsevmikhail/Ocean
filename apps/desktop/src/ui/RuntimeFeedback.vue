<script setup lang="ts">
import type { Run } from '../protocol.js';
defineProps<{
  feedback: string;
  receipt: string;
  readError: string;
  run: Run | undefined;
  label: (id: string) => string;
}>();
</script>
<template>
  <div id="feedback" role="status">
    {{ feedback }}
    <div v-if="receipt">{{ receipt }}</div>
    <div v-if="readError">{{ readError }}</div>
    <div v-if="run">
      {{ run.runId }} · {{ run.turnStatus }} · {{ label(run.performerId) }} [v{{ run.version }}]
    </div>
  </div>
</template>
