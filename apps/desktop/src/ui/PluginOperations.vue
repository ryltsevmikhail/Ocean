<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Glyph from './Glyph.vue';
import type { Room } from '../protocol.js';
import {
  acknowledgePluginOperation,
  clearPluginOperationSelection,
  loadPluginOperations,
  pluginOperationSelected,
  pluginOperationStateLabel,
  pluginOperations,
  pluginOperationsBusy,
  pluginOperationsError,
  pluginOperationsMessage,
  showPluginOperation,
} from './plugin-operations-state.js';

/**
 * Owner-visible durable operation journal (`plugin operations list|show`).
 * Read-only metadata plus one explicit, versioned acknowledgement for an
 * unknown effect; the adapter is never called again from this view.
 */
const props = defineProps<{ room?: Room | undefined; disabled?: boolean }>();
const panel = ref<HTMLDialogElement>();
const selected = computed(() => pluginOperationSelected.value);
const canAcknowledge = computed(
  () => selected.value !== null && selected.value.state === 'uncertain',
);
watch(
  () => props.room?.id,
  () => void refresh(),
);
function open(): void {
  clearPluginOperationSelection();
  panel.value?.showModal();
  void refresh();
}
function close(): void {
  clearPluginOperationSelection();
  panel.value?.close();
}
async function refresh(): Promise<void> {
  await loadPluginOperations(props.room?.id);
}
async function acknowledge(): Promise<void> {
  const current = selected.value;
  if (current === null) return;
  await acknowledgePluginOperation(current.id);
}
</script>
<template>
  <button
    class="round"
    aria-label="Операции плагинов"
    title="Операции плагинов"
    data-testid="plugin-operations-open"
    :disabled="disabled === true"
    @click="open"
  >
    <Glyph name="task" />
  </button>
  <Teleport to="body">
    <dialog
      ref="panel"
      class="provider-panel plugin-panel"
      aria-label="Операции плагинов"
      @cancel="close"
    >
      <header>
        <small>ОПЕРАЦИИ ПЛАГИНОВ</small
        ><button class="round" aria-label="Закрыть операции" @click="close">
          <Glyph name="close" />
        </button>
      </header>
      <p v-if="pluginOperations.length === 0" role="status" data-testid="plugin-operations-empty">
        Записей нет.
      </p>
      <section v-else class="info-card" data-testid="plugin-operations">
        <ul>
          <li v-for="operation in pluginOperations" :key="operation.id">
            <button
              class="link"
              :data-testid="'plugin-operation-' + operation.id"
              :disabled="pluginOperationsBusy"
              @click="showPluginOperation(operation.id)"
            >
              {{ operation.tool }} · {{ operation.repository }} ·
              {{ pluginOperationStateLabel(operation) }}
            </button>
            <span class="muted">
              поколение {{ operation.connectionGeneration }} · rev {{ operation.revision }} ·
              {{ operation.truncated ? 'обрезано' : 'полностью' }}
            </span>
          </li>
        </ul>
      </section>
      <section v-if="selected" class="info-card" data-testid="plugin-operation-detail">
        <strong>{{ selected.id }}</strong>
        <p>{{ pluginOperationStateLabel(selected) }} · {{ selected.outcomeCode ?? '—' }}</p>
        <p class="muted">{{ selected.endpoint }}</p>
        <p class="muted">Аргументы: {{ selected.arguments }}</p>
        <p class="muted">Итог: {{ selected.resultSummary ?? '—' }}</p>
        <p class="muted">
          Создано {{ selected.createdAt }} · завершено {{ selected.settledAt ?? '—' }} · учтено
          {{ selected.acknowledgedAt ?? '—' }}
        </p>
        <div class="form-actions">
          <button
            data-testid="plugin-operation-acknowledge"
            :disabled="pluginOperationsBusy || !canAcknowledge"
            @click="acknowledge"
          >
            Подтвердить неизвестный исход
          </button>
        </div>
      </section>
      <p
        v-if="pluginOperationsMessage !== ''"
        role="status"
        :class="pluginOperationsError ? 'error' : 'muted'"
        data-testid="plugin-operations-message"
      >
        {{ pluginOperationsMessage }}
      </p>
    </dialog>
  </Teleport>
</template>
