import { ref } from 'vue';
import type { Attachment } from '../attachments.js';
import { importFile } from './attachment-api.js';
import { explain } from './dom.js';
const drafts = new Map<string, Attachment[]>();
export function useAttachments(room: () => string) {
  const files = ref<Attachment[]>(drafts.get(room()) ?? []),
    importing = ref(false),
    error = ref('');
  async function add(incoming: File[]) {
    if (importing.value) return;
    error.value = '';
    if (files.value.length + incoming.length > 4) {
      error.value = 'Можно прикрепить до четырёх файлов.';
      return;
    }
    if (incoming.some((f) => f.size > 10 * 1024 * 1024)) {
      error.value = 'Один файл — не более 10 МБ.';
      return;
    }
    importing.value = true;
    try {
      for (const file of incoming) files.value.push(await importFile(room(), file));
    } catch (e) {
      error.value = explain(e);
    } finally {
      drafts.set(room(), files.value);
      importing.value = false;
    }
  }
  function select(event: Event) {
    const picker = event.target;
    if (picker instanceof HTMLInputElement) {
      void add(Array.from(picker.files ?? []));
      picker.value = '';
    }
  }
  return {
    files,
    importing,
    error,
    add,
    select,
    clear: () => {
      files.value = [];
      drafts.delete(room());
    },
  };
}
