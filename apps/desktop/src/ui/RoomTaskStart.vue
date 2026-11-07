<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { Bot } from '../protocol.js';
import type { RoomTasksState } from './room-task-state.js';
import { taskDraft, eligibleTaskGrant } from './room-task-form.js';
import { taskModelText } from './room-task-text.js';
const props = defineProps<{ state: RoomTasksState; members: readonly Bot[] }>();
defineEmits<{ cancel: [] }>();
const text = ref(''),
  participants = ref<string[]>([]),
  initial = ref<string[]>([]),
  selected = ref<string[]>([]);
function reset() {
  text.value = '';
  participants.value = props.members[0] ? [props.members[0].id] : [];
  initial.value = [...participants.value];
  selected.value = [];
}
watch(() => props.state.room.value, reset, { immediate: true });
watch(
  () => props.state.receipt.value,
  (receipt) => {
    if (receipt) reset();
  },
);
watch(
  () => props.state.grants.value,
  () => {
    selected.value = [];
  },
);
watch(participants, (ids) => {
  initial.value = initial.value.filter((id) => ids.includes(id));
  selected.value = [];
});
const draft = computed(() =>
  taskDraft(
    props.state.room.value,
    props.members.map((b) => b.id),
    text.value,
    participants.value,
    initial.value,
    props.state.grants.value,
    selected.value,
  ),
);
const bytes = computed(() => new TextEncoder().encode(text.value).length);
const frozen = computed(
  () => props.state.busy.value || !!props.state.pending.value || props.state.stale.value,
);
</script>
<template>
  <form @submit.prevent="draft && state.start(draft)">
    <h2>Новое поручение</h2>
    <p>Только текст · до 16384 байт UTF-8. Файлы обычного сообщения здесь не передаются.</p>
    <p v-if="state.grantsUnavailable.value">
      Сервисные разрешения не прочитаны. Можно явно начать без сервисных полномочий или перечитать
      настройки.
    </p>
    <fieldset :disabled="frozen">
      <label>Текст поручения<textarea v-model="text" rows="5" required /></label>
      <p>{{ bytes }} / 16384 байт</p>
      <section v-for="bot in members" :key="bot.id" class="info-card">
        <label
          ><input type="checkbox" v-model="participants" :value="bot.id" />Участник @{{
            bot.handle
          }}</label
        >
        <p>{{ taskModelText(bot) }}. Текущая привязка; не историческая модель запуска.</p>
        <label
          ><input
            type="checkbox"
            v-model="initial"
            :value="bot.id"
            :disabled="!participants.includes(bot.id)"
          />Получает первый ход</label
        >
        <template v-if="participants.includes(bot.id)">
          <details
            v-for="g in state.grants.value.filter((g) =>
              eligibleTaskGrant(g, state.room.value, bot.id),
            )"
            :key="`${g.id}@${g.revision}`"
          >
            <summary>
              <label
                ><input type="checkbox" v-model="selected" :value="`${g.id}@${g.revision}`" />{{
                  g.id
                }}
                · rev {{ g.revision }} · {{ g.mode }}</label
              >
            </summary>
            <pre>{{
              JSON.stringify(
                { permissions: g.permissions, mode: g.mode, limits: g.limits },
                null,
                2,
              )
            }}</pre>
          </details>
        </template>
      </section>
      <p>
        Первый ход:
        {{
          members
            .filter((b) => initial.includes(b.id))
            .map((b) => '@' + b.handle)
            .join(', ') || 'выберите'
        }}. Остальные выбранные участники доступны для обмена. Облачным моделям передаётся контекст
        комнаты; сообщения видны участникам.
      </p>
      <p v-if="!selected.length">
        Разговор без сервисных полномочий: пустые ссылки и разрешения. Runtime проверит участников и
        выбранные ревизии повторно.
      </p>
      <button type="submit" :disabled="!draft">Начать поручение</button>
    </fieldset>
    <button type="button" @click="$emit('cancel')">Закрыть форму</button>
  </form>
</template>
<style scoped>
fieldset {
  border: 0;
  padding: 0;
  min-width: 0;
}
textarea {
  width: 100%;
  box-sizing: border-box;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
