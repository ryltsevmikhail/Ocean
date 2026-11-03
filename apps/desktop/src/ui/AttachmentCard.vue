<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { Attachment, AttachmentPreview } from '../attachments.js';
import { previewFile, saveFile, fileSize } from './attachment-api.js';
import { explain } from './dom.js';
import Glyph from './Glyph.vue';
const props = defineProps<{
  file: Attachment;
  room: string;
  removable?: boolean;
  disabled?: boolean;
}>();
defineEmits<{ remove: [] }>();
const preview = ref<AttachmentPreview>(),
  error = ref(''),
  viewer = ref<HTMLDialogElement>(),
  saving = ref(false),
  loaded = ref(false);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
async function load() {
  try {
    const p = await previewFile(props.room, props.file.id);
    if (active) preview.value = p;
  } catch (e) {
    if (active) error.value = explain(e);
  } finally {
    if (active) loaded.value = true;
  }
}
onMounted(() => {
  if (props.file.kind === 'image') void load();
});
function open() {
  viewer.value?.showModal();
  if (!loaded.value) void load();
}
async function save() {
  saving.value = true;
  try {
    await saveFile(props.room, props.file.id);
  } catch (e) {
    error.value = explain(e);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <div class="attachment-card" :class="{ image: file.kind === 'image' }">
    <button
      type="button"
      class="attachment-open"
      :aria-label="'Предпросмотр ' + file.name"
      @click="open"
    >
      <img v-if="preview?.image" :src="preview.image" alt="" /><span v-else class="file-symbol"
        ><Glyph name="file" /></span
      ><span class="file-info"
        ><strong>{{ file.name }}</strong
        ><small
          >{{ fileSize(file.bytes) }} · {{ file.kind === 'image' ? 'Изображение' : 'Файл' }}</small
        ></span
      >
    </button>
    <button
      v-if="removable"
      class="remove-file"
      type="button"
      :disabled="disabled"
      :aria-label="'Убрать ' + file.name"
      @click="$emit('remove')"
    >
      <Glyph name="close" />
    </button>
  </div>
  <Teleport to="body"
    ><dialog ref="viewer" class="attachment-viewer" :aria-label="file.name">
      <header>
        <div>
          <strong>{{ file.name }}</strong
          ><small>{{ fileSize(file.bytes) }} · {{ file.mime }}</small>
        </div>
        <button
          type="button"
          class="round"
          aria-label="Закрыть предпросмотр"
          @click="viewer?.close()"
        >
          <Glyph name="close" />
        </button>
      </header>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="!loaded">Готовим предпросмотр…</p>
      <img v-if="preview?.image" :src="preview.image" :alt="file.name" />
      <pre
        v-else-if="
          preview?.text
        ">{{preview.text}}<span v-if="preview.text.length===6000">\n… Превью ограничено 6000 символами</span></pre>
      <p v-else-if="loaded && !error">
        Для этого типа доступна карточка файла. Сохраните оригинал, чтобы открыть его в подходящем
        приложении.
      </p>
      <footer>
        <span class="checksum">SHA-256 · {{ file.sha256.slice(0, 12) }}…</span
        ><button type="button" :disabled="saving" @click="save">
          <Glyph name="download" /> {{ saving ? 'Сохранение…' : 'Сохранить оригинал' }}
        </button>
      </footer>
    </dialog></Teleport
  >
</template>
