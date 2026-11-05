<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { connectionSettings } from './model-connection-state.js';
import { botModels } from './bot-model-state.js';
import ConnectionRecovery from './ConnectionRecovery.vue';
import BotModelBinding from './BotModelBinding.vue';
const state = connectionSettings,
  bots = botModels;
const {
  connections,
  presets,
  selected,
  key,
  busy,
  stale,
  message,
  pending,
  pendingEntries,
  legacyBlocked,
  checkResult,
  draft,
  current,
  canEdit,
  writeRestriction,
} = state;
const { bots: boundBots, message: botMessage, stale: botStale } = bots;
defineProps<{ disabled: boolean }>();
async function refresh() {
  await Promise.all([state.load(), bots.load()]);
}
onMounted(() => void refresh());
onBeforeUnmount(state.close);
defineExpose({ clear: state.close });
</script>
<template>
  <h2>Подключения и модели ботов</h2>
  <button :disabled="disabled || busy" @click="refresh">Обновить метаданные</button>
  <p v-if="stale" role="status">Редактирование заблокировано до успешного чтения метаданных.</p>
  <label
    >Подключение<select
      :value="selected"
      :disabled="disabled || busy"
      @change="state.select(($event.target as HTMLSelectElement).value)"
    >
      <option value="">Новое подключение</option>
      <option v-if="selected && !current && !pending" :value="selected">
        {{ selected }} · отсутствует в прочитанных метаданных
      </option>
      <option v-for="item in connections" :key="item.connectionId" :value="item.connectionId">
        {{ item.connectionId }} · {{ item.kind }} · {{ item.endpoint }}
      </option>
      <option
        v-for="item in pendingEntries.filter(
          (x) => !connections.some((c) => c.connectionId === x.connectionId),
        )"
        :key="'local:' + item.connectionId"
        :value="item.connectionId"
      >
        {{ item.connectionId }} · локальный исходный запрос; строка не подтверждена
      </option>
    </select></label
  >
  <section v-if="current" class="info-card" role="status">
    <p>{{ current.configuration.intent }} · версия {{ current.revision }} · {{ current.auth }}</p>
    <p>
      Сохранённая ссылка: {{ current.configuration.savedKeyReferencePresent ? 'есть' : 'нет' }};
      после восстановления:
      {{ current.configuration.configuredAfterRestore ? 'настроено' : 'не подтверждено' }}.
    </p>
    <p v-if="!current.writable">Изменение недоступно: {{ current.restriction }}</p>
    <p v-if="current.lastCheck">
      Проверка {{ current.lastCheck.outcome }} · {{ current.lastCheck.checkedAt }} · версия
      {{ current.lastCheck.revision }} · {{ current.lastCheck.source
      }}{{ current.lastCheck.revision !== current.revision ? ' · устарела' : '' }}
    </p>
    <p v-if="current.localQualification">
      Записанная квалификация: {{ current.localQualification.modelId }} ·
      {{ current.localQualification.backendVersion }}. Это запись предыдущей проверки.
    </p>
  </section>
  <p v-if="writeRestriction" role="status">
    Изменение подключений недоступно: {{ writeRestriction }}
  </p>
  <fieldset
    :disabled="
      disabled ||
      (!canEdit &&
        !(
          !legacyBlocked &&
          current?.writable &&
          current.recovery?.kind === 'explicit_key_repair_required' &&
          !busy &&
          !stale &&
          !pending
        ))
    "
  >
    <legend>Явная конфигурация</legend>
    <label v-if="!selected"
      >Предложенный профиль<select
        @change="state.propose(presets[Number(($event.target as HTMLSelectElement).value)]!)"
      >
        <option value="" disabled selected>Выберите профиль ввода</option>
        <option v-for="(item, index) in presets" :key="item.providerId" :value="index">
          {{ item.providerId }} · {{ item.kind }}
        </option>
      </select></label
    >
    <small v-if="!selected"
      >Предложения ввода не подтверждают наличие подключения или модели. Runtime проверяет
      сохранение; локальный backend требует явной проверки.</small
    >
    <label
      >ID подключения<input v-model="draft.connectionId" :disabled="!!selected" required
    /></label>
    <label
      >Cloud / Local<select v-model="draft.kind" :disabled="!!selected">
        <option value="cloud">Cloud</option>
        <option value="local">Local</option>
      </select></label
    >
    <label
      >Провайдер / backend<input v-model="draft.providerId" :disabled="!!selected" required
    /></label>
    <label>Endpoint<input v-model="draft.endpoint" required /></label>
    <label
      >Авторизация<select v-model="draft.auth">
        <option value="api_key">API key</option>
        <option v-if="draft.kind === 'local'" value="none">Без ключа</option>
      </select></label
    >
    <label
      >Модель по умолчанию<input
        v-model="draft.defaultModelId"
        list="connection-model-inputs"
        required
    /></label>
    <datalist id="connection-model-inputs">
      <option v-for="item in current?.models ?? []" :key="item.modelId" :value="item.modelId" />
      <template v-if="!selected"
        ><option
          v-for="id in presets.find((x) => x.providerId === draft.providerId)?.models ?? []"
          :key="id"
          :value="id"
      /></template>
    </datalist>
    <small>Изменение модели по умолчанию не меняет привязки ботов.</small>
  </fieldset>
  <label
    v-if="
      draft.auth === 'api_key' ||
      pending?.requiresKey ||
      (current?.recovery?.kind === 'retry_available' && current.recovery.requiresKeyResupply)
    "
    >Ключ API<input
      v-model="key"
      type="password"
      autocomplete="off"
      spellcheck="false"
      :disabled="
        disabled ||
        busy ||
        stale ||
        legacyBlocked ||
        !!writeRestriction ||
        (current && !current.writable)
      "
  /></label>
  <small
    >Ключ не возвращается из runtime. Поле очищается при отправке, смене выбора и закрытии.</small
  >
  <p v-if="legacyBlocked" role="status">
    Для этого подключения сохранена старая provider-операция. Завершите её в отдельном блоке выше;
    новый запрос недоступен.
  </p>
  <ConnectionRecovery
    :current="current"
    :pending="pending"
    :disabled="disabled || busy || stale || legacyBlocked"
    @recover="state.recover"
    @repair="state.save(true)"
  />
  <p v-if="message" role="status">{{ message }}</p>
  <p v-if="checkResult" role="status">{{ checkResult }}</p>
  <div class="form-actions">
    <button :disabled="disabled || !canEdit" @click="state.save()">Сохранить</button>
    <button
      :disabled="
        disabled || busy || stale || legacyBlocked || !current || !!current.recovery || !!pending
      "
      @click="state.check"
    >
      Проверить явно
    </button>
    <button
      :disabled="disabled || !canEdit || !current"
      @click="state.revisionAction('model-disconnect')"
    >
      Отключить
    </button>
    <button
      :disabled="disabled || !canEdit || !current?.configuration.savedKeyReferencePresent"
      @click="state.revisionAction('model-remove-key')"
    >
      Удалить сохранённый ключ
    </button>
  </div>
  <p class="muted">
    Нет автоматической установки backend, загрузки моделей или переключения на Cloud.
    Неподдерживаемые инструменты и изображения требуют совместимой модели.
  </p>
  <h3>Привязки ботов</h3>
  <p v-if="botStale" role="status">
    Редактирование привязок заблокировано до успешного обновления метаданных ботов.
  </p>
  <p v-if="botMessage" role="status">{{ botMessage }}</p>
  <BotModelBinding
    v-for="item in boundBots"
    :key="item.bot.id"
    :snapshot="item"
    :connections="connections"
    :disabled="
      disabled ||
      stale ||
      botStale ||
      writeRestriction === 'restore_restricted' ||
      !!bots.busy[item.bot.id]
    "
    :message="bots.errors[item.bot.id] ?? ''"
    :uncertain="!!bots.pending[item.bot.id]"
    @save="(binding) => bots.save(item, binding)"
    @recover="bots.retry(item.bot.id)"
  />
</template>
