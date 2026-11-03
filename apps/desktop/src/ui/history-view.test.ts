import { effectScope, nextTick, reactive } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { useHistoryView } from './history-view.js';

afterEach(() => vi.unstubAllGlobals());

function setup(clamped = false) {
  let resized = () => {};
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const state = reactive({ room: 'one', ids: [] as string[] });
  const scope = effectScope();
  const history = scope.run(() =>
    useHistoryView(
      () => state.room,
      () => state.ids.slice(),
    ),
  )!;
  history.view.value = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 } as HTMLElement;
  if (clamped) {
    const el = history.view.value;
    let scrollTop = 0;
    Object.defineProperty(el, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
      },
    });
  }
  history.content.value = {} as HTMLElement;
  return { state, scope, history, resize: () => resized(), disconnect, observe };
}

it('follows new messages and late preview resizing while pinned', async () => {
  const { state, scope, history, resize, disconnect } = setup();
  await nextTick();
  const el = history.view.value!;
  expect(el.scrollTop).toBe(1000);
  Object.assign(el, { scrollHeight: 1300, scrollTop: 800 });
  resize();
  expect(el.scrollTop).toBe(1300);
  Object.assign(el, { scrollHeight: 1500, scrollTop: 1100 });
  state.ids.push('new');
  await nextTick();
  expect(el.scrollTop).toBe(1500);
  scope.stop();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('follows preview growth before a delayed programmatic scroll event', async () => {
  const { scope, history, resize } = setup(true);
  const el = history.view.value!;
  Object.assign(el, { scrollHeight: 873, clientHeight: 525 });
  await nextTick();
  expect(el.scrollTop).toBe(348);
  Object.assign(el, { scrollHeight: 929 });
  // The event from the previous programmatic scroll arrives after preview growth.
  history.scroll();
  resize();
  expect(el.scrollTop).toBe(404);
  scope.stop();
});

it('preserves a real upward scroll when a preview grows', async () => {
  const { scope, history, resize } = setup(true);
  const el = history.view.value!;
  Object.assign(el, { scrollHeight: 873, clientHeight: 525 });
  await nextTick();
  expect(el.scrollTop).toBe(348);
  el.scrollTop = 300;
  Object.assign(el, { scrollHeight: 929 });
  history.scroll();
  resize();
  expect(el.scrollTop).toBe(300);
  scope.stop();
});

it('follows a shrinking view and stays pinned after programmatic scroll events', async () => {
  const { scope, history, resize, disconnect, observe } = setup();
  const el = history.view.value!;
  let scrollTop = 0;
  // Browsers clamp scrollTop to the actual bottom of the viewport.
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
    },
  });
  await nextTick();
  expect(observe.mock.calls.map(([target]) => target)).toEqual([history.content.value, el]);
  expect(el.scrollTop).toBe(800);
  history.scroll();
  Object.assign(el, { clientHeight: 144 });
  resize();
  expect(el.scrollTop).toBe(856);
  expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(2);
  history.scroll();
  Object.assign(el, { clientHeight: 100 });
  resize();
  expect(el.scrollTop).toBe(900);
  scope.stop();
  // Disconnect releases both targets registered on this observer.
  expect(disconnect).toHaveBeenCalledOnce();
});

it('preserves reading position until the user returns to the bottom or switches room', async () => {
  const { state, scope, history, resize } = setup();
  await nextTick();
  const el = history.view.value!;
  el.scrollTop = 300;
  history.scroll();
  Object.assign(el, { scrollHeight: 1300 });
  resize();
  state.ids.push('new');
  await nextTick();
  expect(el.scrollTop).toBe(300);
  el.scrollTop = 1099;
  history.scroll();
  resize();
  expect(el.scrollTop).toBe(1300);
  el.scrollTop = 100;
  history.scroll();
  state.room = 'two';
  state.ids = ['other'];
  await nextTick();
  expect(el.scrollTop).toBe(1300);
  scope.stop();
});

it('silences each room’s initial async history but leaves later additions live', async () => {
  const { state, scope, history } = setup();
  await nextTick();
  state.ids = ['old-a', 'old-b'];
  await nextTick();
  expect([...history.initial.value]).toEqual(['old-a', 'old-b']);
  state.ids.push('new');
  await nextTick();
  expect(history.initial.value.has('new')).toBe(false);
  state.room = 'two';
  state.ids = [];
  await nextTick();
  state.ids = ['other-old'];
  await nextTick();
  expect([...history.initial.value]).toEqual(['other-old']);
  state.ids.push('other-new');
  await nextTick();
  expect(history.initial.value.has('other-new')).toBe(false);
  scope.stop();
});

it('wires log semantics and initial-message suppression into the template', () => {
  const template = readFileSync(new URL('./RoomHistory.vue', import.meta.url), 'utf8');
  expect(template).toContain('role="log"');
  expect(template).toContain('aria-live="polite"');
  expect(template).toContain('aria-relevant="additions"');
  expect(template).toContain(':aria-live="initial.has(m.id) ? \'off\' : undefined"');
  expect(template).toContain('@scroll="scroll"');
  expect(template).toContain('(content = el as HTMLElement)');
});
