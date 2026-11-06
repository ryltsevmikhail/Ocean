import { ref, type Ref } from 'vue';
import type {
  LocalServiceConnectionView,
  LocalServiceOwnerOperationItem,
} from '@runnets/contracts';
import { serviceVersions, type ServiceMutation } from './service-settings-state.js';
/** Fresh material belongs to one explicitly selected prepared request, never the normal form. */
export function createServiceRecovery(deps: {
  key: Ref<string>;
  connections: Ref<readonly LocalServiceConnectionView[]>;
  message: Ref<string>;
  mutate: (command: ServiceMutation) => Promise<void>;
}) {
  const selected = ref<LocalServiceOwnerOperationItem | null>(null),
    key = ref('');
  let binding = '';
  function clear() {
    key.value = '';
    selected.value = null;
    binding = '';
  }
  function select(item: LocalServiceOwnerOperationItem) {
    clear();
    deps.key.value = '';
    if (item.state !== 'prepared' || !item.operation) return;
    selected.value = item;
    binding = JSON.stringify(item);
  }
  async function recover(item: LocalServiceOwnerOperationItem) {
    const secret = key.value;
    key.value = '';
    deps.key.value = '';
    if (!selected.value || binding !== JSON.stringify(item)) {
      deps.message.value = 'Сначала выберите точный исходный запрос и заново введите его ключ.';
      return;
    }
    const op = item.operation;
    if (item.state !== 'prepared' || !op) return;
    if (op.requiresKey && !secret) {
      deps.message.value = 'Введите свежий ключ для выбранного запроса и адреса.';
      return;
    }
    const c = deps.connections.value.find((x) => x.id === op.input.connectionId);
    const expectedVersions = c ? serviceVersions(c) : null,
      requestId = crypto.randomUUID();
    if (op.method === 'service.connection-set')
      await deps.mutate({
        op: 'service-set',
        input: {
          ...op.input,
          requestId,
          expectedVersions,
          ...(op.requiresKey ? { key: secret } : {}),
        },
      });
    else if (expectedVersions)
      await deps.mutate({
        op: 'service-refresh',
        input: { ...op.input, requestId, expectedVersions },
      });
    else deps.message.value = 'Подключение отсутствует; обновление невозможно.';
  }
  return { selected, key, clear, select, recover };
}
