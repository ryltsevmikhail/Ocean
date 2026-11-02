<script setup lang="ts">
import { ref, watch } from 'vue';
import Glyph from './Glyph.vue';
import AttachmentCard from './AttachmentCard.vue';
import { useAttachments } from './composer-attachments.js';
import type { Bot } from '../protocol.js';
const props = defineProps<{
  roomId: string;
  group: boolean;
  members: Bot[];
  busy: boolean;
  pending: string;
  sent: number;
}>();
const recipient = defineModel<string>('recipient', { required: true });
const draft = defineModel<string>('draft', { required: true });
const emit = defineEmits<{ send: [attachments: string[]]; stop: [] }>();
const picker = ref<HTMLInputElement>();
const { files, importing, error, add, select, clear } = useAttachments(() => props.roomId);
watch(
  () => props.sent,
  () => {
    clear();
  },
);
function send() {
  if (!props.busy && !importing.value)
    emit(
      'send',
      files.value.map((f) => f.id),
    );
}
function drop(event: DragEvent) {
  if (!props.busy) void add(Array.from(event.dataTransfer?.files ?? []));
}
function paste(event: ClipboardEvent) {
  const incoming = Array.from(event.clipboardData?.files ?? []);
  if (incoming.length && !props.busy) {
    event.preventDefault();
    void add(incoming);
  }
}
</script>
<template>
  <form id="composer" @submit.prevent="send" @dragover.prevent @drop.prevent="drop" @paste="paste">
    <div class="composer-box">
      <div v-if="files.length" class="attached-files">
        <AttachmentCard
          v-for="(file, i) in files"
          :key="file.id"
          :file="file"
          :room="roomId"
          removable
          :disabled="busy || importing"
          @remove="files.splice(i, 1)"
        />
      </div>
      <div class="compose-line">
        <textarea
          id="draft"
          v-model="draft"
          rows="1"
          :disabled="busy"
          aria-label="Сообщение"
          :placeholder="recipient ? 'Сообщение для @' + recipient + '…' : 'Сообщение в комнату…'"
          maxlength="16384"
        ></textarea>
      </div>
      <div class="compose-tools">
        <div class="compose-left">
          <input
            ref="picker"
            :disabled="busy || importing"
            type="file"
            multiple
            hidden
            @change="select"
          />
          <button
            type="button"
            class="attach"
            aria-label="Прикрепить файл"
            title="Прикрепить файл"
            :disabled="busy || importing || files.length >= 4"
            @click="picker?.click()"
          >
            <Glyph name="attachment" />
          </button>
          <label v-if="group" class="recipient"
            ><span class="sr-only">Кому</span
            ><select v-model="recipient" :disabled="busy">
              <option value="">Всем · заметка</option>
              <option v-for="b in members" :key="b.id" :value="b.handle">@{{ b.handle }}</option>
            </select></label
          >
        </div>
        <button v-if="pending" type="button" @click="$emit('stop')">Запросить отмену</button
        ><button
          class="send"
          aria-label="Отправить"
          title="Отправить"
          :disabled="busy || importing || (!draft.trim() && !files.length)"
        >
          <Glyph name="send" />
        </button>
      </div>
    </div>
    <small v-if="files.length" class="attachment-note"
      >Файлы сохраняются в комнате. Текст передаётся модели отрывками. Анализ изображений пока
      недоступен.</small
    >
    <small v-if="importing" role="status">Прикрепляем файлы…</small>
    <p v-if="error" role="alert">{{ error }}</p>
  </form>
</template>
