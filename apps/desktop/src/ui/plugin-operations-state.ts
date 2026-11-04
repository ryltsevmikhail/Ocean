import { ref } from 'vue';
import { call } from './bridge.js';
import { explain } from './dom.js';
import type { PluginOperationView } from '../plugin-protocol.js';

/**
 * Desktop durable plugin-operation state.
 *
 * The journal is runtime-owned; this view renders bounded metadata only. An
 * acknowledgement is an explicit, versioned owner statement that keeps the
 * unknown effect recorded and releases the journal hold — it never retries.
 */
export const pluginOperations = ref<PluginOperationView[]>([]);
export const pluginOperationSelected = ref<PluginOperationView | null>(null);
export const pluginOperationsBusy = ref(false);
export const pluginOperationsMessage = ref('');
export const pluginOperationsError = ref(false);

function explainFailure(error: unknown): void {
  pluginOperationsMessage.value = explain(error);
  pluginOperationsError.value = true;
}

async function run(action: () => Promise<string>): Promise<void> {
  if (pluginOperationsBusy.value) return;
  pluginOperationsBusy.value = true;
  pluginOperationsMessage.value = '';
  pluginOperationsError.value = false;
  try {
    pluginOperationsMessage.value = await action();
  } catch (error) {
    explainFailure(error);
  } finally {
    pluginOperationsBusy.value = false;
  }
}

export function pluginOperationStateLabel(operation: PluginOperationView): string {
  switch (operation.state) {
    case 'started':
      return 'Выполняется';
    case 'observed':
      return 'Результат получен';
    case 'failed':
      return 'Ошибка сервиса';
    case 'not_started':
      return 'Не отправлялось';
    case 'uncertain':
      return 'Исход неизвестен';
    case 'acknowledged':
      return 'Неизвестный исход подтверждён владельцем';
  }
}

export async function loadPluginOperations(roomId?: string): Promise<void> {
  try {
    pluginOperations.value = await call({
      op: 'plugin-operations-list',
      ...(roomId === undefined ? {} : { room: roomId }),
    });
    const selected = pluginOperationSelected.value;
    if (selected !== null) {
      const current = pluginOperations.value.find((entry) => entry.id === selected.id) ?? null;
      pluginOperationSelected.value = current;
    }
  } catch (error) {
    explainFailure(error);
  }
}

export async function showPluginOperation(operationId: string): Promise<void> {
  await run(async () => {
    pluginOperationSelected.value = await call({ op: 'plugin-operation-show', operationId });
    return 'Операция загружена.';
  });
}

export async function acknowledgePluginOperation(operationId: string): Promise<void> {
  const current = pluginOperations.value.find((entry) => entry.id === operationId);
  if (current === undefined) return;
  await run(async () => {
    const acknowledged = await call({
      op: 'plugin-operation-acknowledge',
      operationId,
      expectedRevision: current.revision,
    });
    pluginOperationSelected.value = acknowledged;
    await loadPluginOperations();
    return 'Неизвестный исход подтверждён. Повторная отправка не выполняется.';
  });
}

export function clearPluginOperationSelection(): void {
  pluginOperationSelected.value = null;
  pluginOperationsMessage.value = '';
  pluginOperationsError.value = false;
}
