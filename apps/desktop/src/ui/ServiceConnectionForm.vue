<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ServiceSettings } from './service-settings-state.js';
const props = defineProps<{ state: ServiceSettings }>();
const {
  connections,
  selected,
  key,
  busy,
  stale,
  message,
  current,
  draft,
  receipt,
  pending,
  operations,
} = props.state;
const readinessText = {
  ready: 'Готово',
  disconnected: 'Отключено',
  metadata_required: 'Требуются метаданные',
  unavailable: 'Недоступно',
  unknown: 'Неизвестно',
};
const receiptId = ref('');
const locked = computed(() => busy.value || stale.value);
function optional(field: 'workspaceRoot' | 'packageJsonSha256', value: string) {
  if (draft.configuration.kind !== 'stdio') return;
  const copy = { ...draft.configuration };
  delete copy[field];
  draft.configuration = value ? { ...copy, [field]: value } : copy;
}
function transport(kind: string) {
  key.value = '';
  draft.configuration =
    kind === 'stdio'
      ? { kind: 'stdio', executable: '', sha256: '', args: [] }
      : { kind: 'http', url: '' };
}
</script>
<template>
  <h2>Сервисы</h2>
  <button data-testid="service-reload" :disabled="busy" @click="state.load">Обновить записи</button>
  <p v-if="stale" role="status">Редактирование недоступно до успешного чтения runtime.</p>
  <label
    >Подключение<select
      data-testid="service-select"
      :value="selected"
      :disabled="stale"
      @change="state.select(($event.target as HTMLSelectElement).value)"
    >
      <option value="">Новое подключение</option>
      <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }} · {{ c.id }}</option>
    </select></label
  >
  <section
    v-if="current"
    class="info-card"
    data-testid="service-current"
    :data-readiness="current.readiness"
  >
    <p>
      Готовность: {{ readinessText[current.readiness] }} · состояние:
      {{ current.state === 'active' ? 'активно' : 'отключено' }}
    </p>
    <p>
      Записанное разрешение метаданных:
      {{ current.trust.metadataPermission === 'allow' ? 'разрешены' : 'не разрешены' }}
    </p>
    <p>
      Версии: config {{ current.configRevision }} / trust {{ current.trustRevision }} / key
      {{ current.credentialRevision }}
    </p>
    <p>Опубликованные инструменты:</p>
    <ul>
      <li v-for="tool in current.tools" :key="tool">{{ tool }}</li>
    </ul>
    <pre class="service-exact">{{ JSON.stringify(current.trust, null, 2) }}</pre>
    <small
      >Метка аккаунта, схема и старое identity не доказывают текущую область ресурсов. Записанное
      разрешение отдельно от фактической готовности.</small
    >
  </section>
  <fieldset :disabled="locked">
    <legend>Явная конфигурация</legend>
    <label
      >ID<input data-testid="service-id" v-model="draft.connectionId" :disabled="!!selected"
    /></label>
    <label>Название<input data-testid="service-name" v-model="draft.name" /></label>
    <label
      >Транспорт<select
        data-testid="service-transport"
        :value="draft.configuration.kind"
        @change="transport(($event.target as HTMLSelectElement).value)"
      >
        <option value="http">HTTP</option>
        <option value="stdio">Pinned Node stdio</option>
      </select></label
    >
    <label v-if="draft.configuration.kind === 'http'"
      >HTTP URL<input data-testid="service-url" v-model="draft.configuration.url"
    /></label>
    <template v-else>
      <label
        >Абсолютный путь Node artifact<input
          data-testid="service-executable"
          v-model="draft.configuration.executable"
      /></label>
      <label>SHA256<input v-model="draft.configuration.sha256" /></label>
      <label
        >package.json SHA256 (необязательно)<input
          :value="draft.configuration.packageJsonSha256 ?? ''"
          @input="optional('packageJsonSha256', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        >Изолированный workspaceRoot (необязательно)<input
          :value="draft.configuration.workspaceRoot ?? ''"
          @input="optional('workspaceRoot', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        ><input
          type="checkbox"
          :checked="draft.configuration.args.length > 0"
          @change="
            draft.configuration = {
              ...draft.configuration,
              args: ($event.target as HTMLInputElement).checked ? ['/workspace'] : [],
            }
          "
        />Передать /workspace</label
      >
      <small
        >Только закреплённый Node artifact; ключи/env и установка команд здесь не
        поддерживаются.</small
      >
    </template>
    <label
      >Разрешение метаданных<select
        data-testid="service-permission"
        v-model="draft.metadataPermission"
      >
        <option value="none">Не разрешены</option>
        <option value="allow">Разрешить запрос метаданных</option>
      </select></label
    >
    <label v-if="draft.configuration.kind === 'http'"
      >Приватный ключ (необязательно)<input
        data-testid="service-key"
        v-model="key"
        type="password"
        autocomplete="off"
        spellcheck="false"
    /></label>
    <small
      >Ключ очищается до ожидания ответа, при смене контекста и закрытии. Выбор записи не вызывает
      discovery.</small
    >
    <div class="form-actions">
      <button data-testid="service-save" @click="state.save()">Сохранить явно</button
      ><button
        v-if="current"
        data-testid="service-refresh"
        @click="state.action('service-refresh')"
      >
        Запросить метаданные</button
      ><button
        v-if="current"
        data-testid="service-disconnect"
        @click="state.action('service-disconnect')"
      >
        Отключить</button
      ><button
        v-if="current?.configuration.kind === 'http'"
        data-testid="service-remove-key"
        @click="state.save(true)"
      >
        Удалить ключ
      </button>
    </div>
  </fieldset>
  <section v-if="pending || operations.length" class="info-card">
    <h3>Исходные операции</h3>
    <p v-if="pending">
      Последний requestId: {{ pending.requestId }}
      <button :disabled="busy" @click="state.lookup(pending.requestId)">Исходная квитанция</button>
    </p>
    <section v-for="item in operations" :key="item.requestId" data-testid="service-prepared">
      <p>
        {{ item.requestId }} · {{ item.method }} · {{ item.state }} ·
        {{ item.targetId ?? 'неизвестно' }}
      </p>
      <pre class="service-exact">{{ JSON.stringify(item.operation, null, 2) }}</pre>
      <p v-if="!item.operation">
        Исторический intent неизвестен; только чтение и ручная настройка.
      </p>
      <p v-else>
        Новое явное восстановление использует новый requestId и текущие версии; старый prepared факт
        сохраняется. {{ item.operation.requiresKey ? 'Введите ключ заново в поле выше.' : '' }}
      </p>
      <button :disabled="busy" @click="state.lookup(item.requestId)">Исходная квитанция</button>
      <button
        v-if="item.operation"
        data-testid="service-recover"
        :disabled="locked"
        @click="state.recover(item)"
      >
        Новое явное восстановление
      </button>
    </section>
  </section>
  <label>Исходный requestId<input data-testid="service-receipt-id" v-model="receiptId" /></label
  ><button
    data-testid="service-receipt-lookup"
    :disabled="busy || !receiptId"
    @click="state.lookup(receiptId)"
  >
    Найти исходную квитанцию
  </button>
  <section v-if="receipt" data-testid="service-receipt">
    <strong>Исходная квитанция — не текущая запись</strong>
    <pre class="service-exact">{{ JSON.stringify(receipt, null, 2) }}</pre>
  </section>
  <p v-if="message" role="status" data-testid="service-message">{{ message }}</p>
</template>
<style scoped>
.service-exact {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 100%;
}
</style>
