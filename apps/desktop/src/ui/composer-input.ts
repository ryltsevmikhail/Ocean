import { ref, watch } from 'vue';

export function useComposerInput(disabled: () => boolean, sent: () => number, submit: () => void) {
  const field = ref<HTMLTextAreaElement>();
  function send() {
    if (!disabled()) submit();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send();
  }
  watch(sent, () => field.value?.focus(), { flush: 'post' });
  return { field, send, keydown };
}
