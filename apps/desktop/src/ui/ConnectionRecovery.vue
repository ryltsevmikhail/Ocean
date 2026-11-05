<script setup lang="ts">
import type { LocalModelConnectionMetadata } from '../model-protocol.js';
import type { PendingConnectionMutation } from './model-settings-recovery.js';
defineProps<{
  current: LocalModelConnectionMetadata | undefined;
  pending: PendingConnectionMutation | null;
  disabled: boolean;
}>();
defineEmits<{ recover: []; repair: [] }>();
</script>
<template>
  <section v-if="current?.recovery || pending" class="info-card warning" role="status">
    <template v-if="current?.recovery?.kind === 'retry_available'">
      <strong>Завершить исходную операцию</strong>
      <p>
        {{ current.recovery.request.operation.method }} ·
        {{ current.recovery.request.operation.input.requestId }} · pending
        {{ current.recovery.pendingRevision }}
      </p>
      <pre>{{ JSON.stringify(current.recovery.request.operation.input, null, 2) }}</pre>
      <p v-if="current.recovery.requiresKeyResupply">
        Введите тот же исходный ключ. Только runtime проверяет совпадение.
      </p>
      <button :disabled="disabled || !current.writable" @click="$emit('recover')">
        Завершить исходную операцию
      </button>
    </template>
    <template v-else-if="current?.recovery?.kind === 'explicit_key_repair_required'">
      <p>
        Историческая операция не имеет полного описания. Отдельное исправление новым ключом создаёт
        новый запрос с текущей версией. Оно не доказывает очистку неизвестных ссылок.
      </p>
      <button :disabled="disabled || !current.writable || !!pending" @click="$emit('repair')">
        Явно исправить новым ключом
      </button>
    </template>
    <template v-else-if="pending">
      <p>Исход неизвестен: {{ pending.connectionId }}. Метаданные не являются квитанцией успеха.</p>
      <pre>{{ JSON.stringify(pending.command, null, 2) }}</pre>
      <p v-if="pending.requiresKey">Для этого же запроса нужен тот же исходный ключ.</p>
      <button :disabled="disabled || (current && !current.writable)" @click="$emit('recover')">
        Явно повторить точный исходный запрос
      </button>
    </template>
    <p v-else>
      Требуется полный точный исходный ввод. Это окно не может восстановить историческую операцию
      автоматически.
    </p>
  </section>
</template>
