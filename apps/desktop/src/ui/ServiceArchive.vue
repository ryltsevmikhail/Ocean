<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { call } from './bridge.js';
import { legacyServiceProposal } from './service-legacy.js';
import type {
  PluginConnectionView,
  PluginGrantView,
  PluginOperationView,
} from '../plugin-protocol.js';
import type { ServiceSettings } from './service-settings-state.js';
const props = defineProps<{ supported: boolean; state: ServiceSettings }>();
const rows = ref<PluginConnectionView[]>([]),
  grants = ref<PluginGrantView[]>([]),
  operations = ref<PluginOperationView[]>([]),
  message = ref('');
let epoch = 0;
async function load() {
  if (!props.supported) {
    message.value = 'Исторический протокол не поддерживается; ручная настройка.';
    return;
  }
  const token = ++epoch;
  try {
    const [cs, gs, os] = await Promise.all([
      call({ op: 'plugin-connections' }),
      call({ op: 'plugin-access-list' }),
      call({ op: 'plugin-operations-list' }),
    ]);
    if (token !== epoch) return;
    rows.value = cs;
    grants.value = gs;
    operations.value = os;
  } catch (e) {
    if (token === epoch)
      message.value = 'Архив недоступен: ' + String(e instanceof Error ? e.message : e);
  }
}
async function prefill(row: PluginConnectionView) {
  props.state.key.value = '';
  const token = epoch,
    context = props.state.contextEpoch,
    input = await legacyServiceProposal(row);
  if (token !== epoch || context !== props.state.contextEpoch) return;
  if (!input) {
    message.value =
      'Нет доступной декларативной HTTP или pinned Node конфигурации. Нужна ручная настройка.';
    return;
  }
  if (props.state.connections.value.some((c) => c.id === input.connectionId)) {
    message.value =
      'Предложение этого поколения уже существует. Перезапись запрещена; выберите текущую запись.';
    return;
  }
  props.state.select('');
  Object.assign(props.state.draft, {
    connectionId: input.connectionId,
    name: input.name,
    configuration: input.configuration,
    metadataPermission: 'none',
  });
  props.state.key.value = '';
  message.value =
    'Только конфигурация ввода; ключ пуст, metadataPermission none, права не перенесены. Сохраните явно.';
}
onMounted(() => void load());
onBeforeUnmount(() => ++epoch);
</script>
<template>
  <details>
    <summary>Исторический архив — только чтение</summary>
    <p>
      Старые envNAME, generation, schema и identityBool не доказывают непрерывность материала или
      текущие ограничения аккаунта/ресурсов. Старые разрешения остаются архивом; новая широкая
      область является НОВЫМ правом.
    </p>
    <section v-for="row in rows" :key="row.id" class="info-card" data-testid="service-legacy-row">
      <pre>{{ JSON.stringify(row, null, 2) }}</pre>
      <button data-testid="service-legacy-prefill" @click="prefill(row)">
        Предложить известную конфигурацию без ключа и прав
      </button>
    </section>
    <h3>Старые grants</h3>
    <pre>{{ JSON.stringify(grants, null, 2) }}</pre>
    <h3>Старые операции — unknown не исполняется и не подтверждается здесь</h3>
    <pre>{{ JSON.stringify(operations, null, 2) }}</pre>
    <p v-if="message" role="status" data-testid="service-legacy-message">{{ message }}</p>
  </details>
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
