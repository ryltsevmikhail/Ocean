<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useComposerInput } from './composer-input.js';
import Glyph from './Glyph.vue';
import AttachmentCard from './AttachmentCard.vue';
import { useAttachments } from './composer-attachments.js';
import { attachmentHint } from './image-hints.js';
import type { Bot, Run } from '../protocol.js';
import { BROADCAST_RECIPIENT } from './broadcast-mode.js';
const props = defineProps<{
  roomId: string;
  group: boolean;
  members: Bot[];
  busy: boolean;
  sending: boolean;
  active: Run | undefined;
  uncertain: boolean;
  blocked: boolean;
  blockedHint: string;
  sent: number;
}>();
const recipient = defineModel<string>('recipient', { required: true });
const draft = defineModel<string>('draft', { required: true });
const emit = defineEmits<{
  send: [attachments: string[]];
  broadcast: [attachments: string[]];
  stop: [run: Run];
}>();
const picker = ref<HTMLInputElement>();
const { files, importing, error, add, select, clear } = useAttachments(() => props.roomId);
watch(
  () => props.sent,
  () => {
    clear();
  },
);
const imageHint = computed(() =>
  attachmentHint({
    files: files.value,
    members: props.members,
    group: props.group,
    recipient: recipient.value,
    broadcast: BROADCAST_RECIPIENT,
  }),
);
const sendDisabled = computed(
  () =>
    props.busy ||
    importing.value ||
    // A batch holds model turns until the owner decides; Notes stay available.
    (props.blocked && recipient.value !== '') ||
    (!props.uncertain && !draft.value.trim() && !files.value.length),
);
const { field, send, keydown } = useComposerInput(
  () => sendDisabled.value,
  () => props.sent,
  () => {
    const ids = files.value.map((f) => f.id);
    if (props.group && recipient.value === BROADCAST_RECIPIENT) emit('broadcast', ids);
    else emit('send', ids);
  },
);
function drop(event: DragEvent) {
  if (!props.busy && !props.uncertain) void add(Array.from(event.dataTransfer?.files ?? []));
}
function paste(event: ClipboardEvent) {
  const incoming = Array.from(event.clipboardData?.files ?? []);
  if (incoming.length && !props.busy && !props.uncertain) {
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
          :disabled="busy || uncertain || importing"
          @remove="files.splice(i, 1)"
        />
      </div>
      <div class="compose-line">
        <textarea
          id="draft"
          :ref="(element) => (field = element as HTMLTextAreaElement | undefined)"
          @keydown="keydown"
          aria-describedby="composer-hint"
          v-model="draft"
          rows="1"
          :readonly="busy || uncertain"
          :aria-busy="busy"
          aria-label="Сообщение"
          :placeholder="
            recipient === BROADCAST_RECIPIENT
              ? 'Один вопрос всем участникам…'
              : recipient
                ? 'Сообщение для @' + recipient + '…'
                : 'Сообщение в комнату…'
          "
          maxlength="16384"
        ></textarea>
      </div>
      <div class="compose-tools">
        <div class="compose-left">
          <input
            ref="picker"
            :disabled="busy || uncertain || importing"
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
            :disabled="busy || uncertain || importing || files.length >= 4"
            @click="picker?.click()"
          >
            <Glyph name="attachment" />
          </button>
          <label v-if="group" class="recipient"
            ><span class="sr-only">Кому</span
            ><select v-model="recipient" :disabled="busy || uncertain">
              <option :value="BROADCAST_RECIPIENT">Всем (broadcast)</option>
              <option value="">Заметка</option>
              <option v-for="b in members" :key="b.id" :value="b.handle">@{{ b.handle }}</option>
            </select></label
          >
        </div>
        <span v-if="sending" role="status">Отправляем…</span>
        <button
          v-if="active"
          :disabled="busy"
          type="button"
          @click="$emit('stop', active)"
          :aria-label="
            'Остановить ответ @' +
            (members.find((b) => b.id === active?.performerId)?.handle ?? 'участник')
          "
        >
          Остановить</button
        ><button
          class="send"
          :aria-label="uncertain ? 'Повторить исходный запрос' : 'Отправить'"
          :title="uncertain ? 'Повторить исходный запрос' : 'Отправить'"
          :disabled="sendDisabled"
        >
          <Glyph name="send" />
        </button>
      </div>
    </div>
    <small id="composer-hint">Enter — отправить, Shift+Enter — новая строка</small>
    <small v-if="imageHint" class="attachment-note">{{ imageHint }}</small>
    <small v-if="uncertain"
      >Повторная отправка проверит тот же запрос с теми же вложениями и адресатом.</small
    >
    <small v-if="group && recipient === BROADCAST_RECIPIENT"
      >Всем: один вопрос, по одному ответу от каждого участника, без автоматических раундов.
      Приостановленную рассылку можно продолжить или оставить в панели рассылки.</small
    >
    <small v-if="blocked && recipient !== ''" role="status">{{ blockedHint }}</small>
    <small v-if="importing" role="status">Прикрепляем файлы…</small>
    <p v-if="error" role="alert" class="runtime-error">{{ error }}</p>
  </form>
</template>
