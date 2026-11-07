<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import type { Bot, Message } from '../protocol.js';
import type { RoomTasksState } from './room-task-state.js';
import RoomTaskStart from './RoomTaskStart.vue';
import RoomTaskDecisions from './RoomTaskDecisions.vue';
import { taskRowText } from './room-task-text.js';
const props = defineProps<{
  state: RoomTasksState;
  members: readonly Bot[];
  history: readonly Message[];
}>();
const emit = defineEmits<{ services: [] }>();
const entry = ref<HTMLButtonElement>();
const panel = ref<HTMLDialogElement>(),
  form = ref(false),
  opened = ref(false);
const {
  roots,
  view,
  selected,
  stale,
  message,
  supported,
  reading,
  next,
  busy,
  pending,
  receipt,
  current,
  stopUnknown,
} = props.state;
const label = (id: string) =>
  props.members.find((b) => b.id === id)?.handle
    ? '@' + props.members.find((b) => b.id === id)!.handle
    : id;
const refs = computed(
  () =>
    view.value?.rows.flatMap((row) =>
      row.type === 'slice'
        ? row.pendingDecisionIds.map((decisionId) => ({
            workspaceId: 'ws_ocean',
            roomId: props.state.room.value,
            runId: row.runId,
            decisionId,
          }))
        : [],
    ) ?? [],
);
function title(messageId: string) {
  return (
    props.history
      .find((m) => m.roomId === props.state.room.value && m.id === messageId)
      ?.body.slice(0, 120) || messageId
  );
}
function open() {
  opened.value = true;
  panel.value?.showModal();
  void props.state.refresh();
}
function close() {
  opened.value = false;
  panel.value?.close();
}
function services() {
  close();
  entry.value?.focus();
  emit('services');
}
onBeforeUnmount(() => props.state.close());
</script>
<template>
  <button
    ref="entry"
    class="round team-entry"
    :title="view ? `${view.status}${refs.length ? ' · решение' : ''}` : 'Задачи команды'"
    aria-label="Задачи команды"
    :aria-expanded="opened"
    @click="open"
  >
    Задачи команды<span v-if="view">{{ view.status }}{{ refs.length ? ' · решение' : '' }}</span>
  </button>
  <Teleport to="body">
    <dialog
      ref="panel"
      class="provider-panel room-work team-tasks"
      aria-label="Задачи команды"
      @cancel.prevent="close"
      @close="opened = false"
    >
      <header>
        <small>ЗАДАЧИ КОМАНДЫ</small
        ><button class="round" aria-label="К разговору" @click="close">×</button>
      </header>
      <p>Закрытие окна не останавливает задачи. Обычный черновик и файлы остаются в разговоре.</p>
      <button :disabled="reading || busy" @click="state.refresh()">Перечитать задачи</button>
      <button :disabled="supported !== true || stale || busy || !!pending" @click="form = true">
        Новое поручение
      </button>
      <button @click="services">Сервисы и разрешения комнаты</button>
      <p v-if="stale" role="status">Данные не подтверждены или устарели; действия недоступны.</p>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="supported === true && !stale && !roots.length">Серверный список пуст.</p>
      <ul>
        <li v-for="root in roots" :key="root.rootId">
          <button
            :aria-pressed="selected === root.rootId"
            :disabled="busy"
            @click="state.select(root.rootId)"
          >
            {{ title(root.startMessageId) }} · {{ root.status }} ·
            {{
              root.authority === 'historical' ? 'исторический, только чтение' : 'текущая область'
            }}
          </button>
        </li>
      </ul>
      <button v-if="next !== null" :disabled="reading || busy" @click="state.refresh(true)">
        Более ранние поручения
      </button>
      <section v-if="view" class="info-card">
        <p v-if="!current">
          Только чтение: исторический корень или его текущая область ещё не прочитана на этой
          странице списка.
        </p>
        <h2>{{ view.rootId }} · {{ view.status }} · rev {{ view.revision }}</h2>
        <p>Счётчики: {{ view.counts }} · ограждение: {{ view.fenceReason?.code ?? 'нет' }}</p>
        <p v-if="view.status === 'stopped'">
          Корень остановлен; очистка дочерних запусков и исход внешних эффектов этой записью не
          подтверждены.
        </p>
        <ul>
          <li v-for="(row, index) in view.rows" :key="index">
            {{ taskRowText(row, view, label) }}
          </li>
        </ul>
        <button
          v-if="current && ['ready', 'paused'].includes(view.status)"
          :disabled="stale || busy || stopUnknown"
          @click="state.stop()"
        >
          Остановить корень · rev {{ view.revision }}
        </button>
        <RoomTaskDecisions
          v-if="opened && current"
          :key="`${state.binding.value?.profileId}/${state.binding.value?.instanceId}/${selected}`"
          :state="state"
          :refs="refs"
        />
      </section>
      <section v-if="receipt">
        <h3>Квитанция поручения</h3>
        <p>{{ receipt.rootId }} · {{ receipt.messageId }} · seq {{ receipt.seq }}</p>
        <p v-for="d in receipt.deliveries" :key="d.deliveryId">
          {{ label(d.botId) }} · {{ d.taskId }} · {{ d.deliveryId }}
        </p>
      </section>
      <section v-if="pending">
        <p>
          Неизменяемый исходный запрос {{ pending.input.requestId }} · профиль
          {{ pending.profileId }}. Перечитайте список перед явным повтором.
        </p>
        <pre>{{ pending.input.text }}</pre>
        <button :disabled="stale || busy" @click="state.replay()">
          Повторить только исходный запрос
        </button>
      </section>
      <RoomTaskStart
        v-if="form && opened"
        :state="state"
        :members="members"
        @cancel="form = false"
      />
    </dialog>
  </Teleport>
</template>
<style scoped>
.team-entry {
  width: 116px;
  height: 32px;
  padding: 2px 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.1;
}
.team-entry span {
  font-size: 10px;
  max-width: 104px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-tasks {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  min-width: 0;
  overflow: auto;
  overflow-wrap: anywhere;
  box-sizing: border-box;
}
.team-tasks :deep(*) {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.team-tasks :deep(button) {
  white-space: normal;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
