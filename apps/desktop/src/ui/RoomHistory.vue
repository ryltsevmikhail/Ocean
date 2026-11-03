<script setup lang="ts">
import { useHistoryView } from './history-view.js';
import type { Message } from '../protocol.js';
import Avatar from './Avatar.vue';
import AttachmentCard from './AttachmentCard.vue';
const props = defineProps<{
  history: Message[];
  roomId: string;
  busy: boolean;
  group: boolean;
  handle?: string | undefined;
  label: (id: string | undefined) => string;
}>();
const { view, content, initial, scroll } = useHistoryView(
  () => props.roomId,
  () => props.history.map((m) => m.id),
);
const clock = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
function day(s: string) {
  const d = new Date(s);
  return d.toDateString() === new Date().toDateString() ? 'Сегодня' : calendar.format(d);
}
</script>
<template>
  <section
    :ref="(el) => (view = el as HTMLElement)"
    id="history"
    role="log"
    aria-live="polite"
    aria-relevant="additions"
    aria-label="История комнаты"
    @scroll="scroll"
  >
    <div :ref="(el) => (content = el as HTMLElement)" class="history-content">
      <div v-if="!history.length && !busy" class="empty-chat" aria-live="off">
        <Avatar :handle="handle" />
        <h2>Начало разговора</h2>
        <p>
          {{
            group
              ? 'Выберите участника и отправьте первое сообщение.'
              : 'Отправьте первое сообщение в личную комнату.'
          }}
        </p>
      </div>
      <template v-for="(m, i) in history" :key="m.id"
        ><small
          v-if="!i || day(history[i - 1]!.createdAt) !== day(m.createdAt)"
          class="day"
          aria-live="off"
          >{{ day(m.createdAt) }}</small
        >
        <article class="post" :class="m.author" :aria-live="initial.has(m.id) ? 'off' : undefined">
          <header>
            <span class="author"
              ><Avatar v-if="m.author === 'bot'" :handle="label(m.authorBotId)" />{{
                m.author === 'bot' ? '@' + label(m.authorBotId) : 'Вы'
              }}<span v-if="m.author === 'user' && m.targetBotId">
                → @{{ label(m.targetBotId) }}</span
              ></span
            ><time :datetime="m.createdAt"
              >{{ clock.format(new Date(m.createdAt))
              }}<span v-if="m.author === 'user'"> · Отправлено</span></time
            >
          </header>
          <p v-if="m.body">{{ m.body }}</p>
          <div v-if="m.attachments?.length" class="message-files">
            <AttachmentCard
              v-for="file in m.attachments"
              :key="file.id"
              :room="m.roomId"
              :file="file"
            />
          </div></article
      ></template>
    </div>
  </section>
</template>
<style scoped>
.history-content {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-start;
  gap: 22px;
  width: 100%;
}
.history-content:has(.empty-chat) {
  margin-block: auto;
}
</style>
