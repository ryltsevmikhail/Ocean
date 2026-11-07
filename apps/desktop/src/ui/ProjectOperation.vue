<script setup lang="ts">
import { computed } from 'vue';
import type { OperationKey, OperationStatus } from '../project-protocol.js';
import type { ProjectRequest } from './project-bridge.js';
import { projectStatus } from './project-state.js';
import { decisionStatusText } from './service-decisions.js';
import ProjectDecision from './ProjectDecision.vue';

const props = defineProps<{
  request: ProjectRequest;
  handle: OperationKey;
  status?: OperationStatus | undefined;
  disabled?: boolean;
}>();
defineEmits<{ decided: [] }>();
const title = {
  reserve: 'Подтверждение резерва',
  prepare: 'Подтверждение подготовки',
  review: 'Подтверждение ревью',
  apply: 'Подтверждение применения',
};
const result = computed(() => props.status?.result);
</script>
<template>
  <div class="project-operation">
    <p v-if="result?.decision">Решение: {{ decisionStatusText[result.decision.status] }}</p>
    <p role="status">
      Результат:
      {{
        result
          ? projectStatus('state' in result ? result.state : result.status)
          : 'не подтверждён. Обновите состояние.'
      }}
    </p>
    <p v-if="status?.operation === 'apply' && status.result.receipt">
      Запись {{ status.result.receipt.id }} · файлов {{ status.result.receipt.completedFiles }}/{{
        status.result.receipt.fileCount
      }}
      <span v-if="status.result.receipt.uncertainFiles">
        · неизвестно: {{ status.result.receipt.uncertainFiles }}</span
      >
    </p>
    <ProjectDecision
      v-if="!result || result.decision"
      :key="handle.requestId"
      :title="title[handle.operation]"
      :disabled="Boolean(disabled)"
      :inspect="() => request('operation-card', handle)"
      :resolve="(choice) => request('operation-vote', { ...handle, ...choice })"
      @decided="$emit('decided')"
    />
  </div>
</template>
