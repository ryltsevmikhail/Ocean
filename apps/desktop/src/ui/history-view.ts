import { onScopeDispose, ref, watch } from 'vue';

export function useHistoryView(room: () => string, ids: () => string[]) {
  const view = ref<HTMLElement>();
  const content = ref<HTMLElement>();
  const initial = ref(new Set<string>());
  let pinned = true;
  let awaitingHistory = true;
  let programmaticTop: number | undefined;

  function scroll() {
    const el = view.value;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
      pinned = true;
    } else if (programmaticTop !== undefined && Math.abs(el.scrollTop - programmaticTop) <= 1) {
      resize();
    } else {
      pinned = false;
    }
  }
  function resize() {
    const el = view.value;
    if (el && pinned) {
      el.scrollTop = el.scrollHeight;
      programmaticTop = el.scrollTop;
    }
  }
  watch(
    room,
    () => {
      pinned = true;
      programmaticTop = undefined;
      awaitingHistory = true;
      initial.value = new Set();
    },
    { immediate: true, flush: 'sync' },
  );
  watch(
    ids,
    (messages) => {
      // The first asynchronously loaded batch is existing history, not new speech.
      if (awaitingHistory && messages.length) {
        initial.value = new Set(messages);
        awaitingHistory = false;
      }
    },
    { immediate: true },
  );
  watch(ids, resize, { flush: 'post' });
  watch(view, resize, { flush: 'post' });
  const stop = watch(
    [content, view],
    ([contentEl, viewEl], _, cleanup) => {
      const observer = new ResizeObserver(resize);
      if (contentEl) observer.observe(contentEl);
      if (viewEl) observer.observe(viewEl);
      cleanup(() => observer.disconnect());
    },
    { flush: 'post' },
  );
  onScopeDispose(stop);
  return { view, content, initial, scroll };
}
