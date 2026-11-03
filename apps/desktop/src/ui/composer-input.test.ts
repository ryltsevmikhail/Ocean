import { effectScope, nextTick, reactive } from 'vue';
import { expect, it, vi } from 'vitest';
import { useComposerInput } from './composer-input.js';

function setup() {
  const state = reactive({ disabled: false, sent: 0 });
  const submit = vi.fn();
  const focus = vi.fn();
  const scope = effectScope();
  const input = scope.run(() =>
    useComposerInput(
      () => state.disabled,
      () => state.sent,
      submit,
    ),
  )!;
  input.field.value = { focus } as unknown as HTMLTextAreaElement;
  return { state, submit, focus, scope, ...input };
}
function key(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}
it.each([{}, { ctrlKey: true }, { metaKey: true }])('sends on Enter (%j)', (modifiers) => {
  const input = setup();
  const event = key(modifiers);
  input.keydown(event);
  expect(input.submit).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  input.scope.stop();
});
it.each([{ shiftKey: true }, { isComposing: true }, { key: 'a' }])(
  'preserves native input without sending (%j)',
  (modifiers) => {
    const input = setup();
    const event = key(modifiers);
    input.keydown(event);
    expect(input.submit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    input.scope.stop();
  },
);
it('applies the same disabled guard to keyboard and form submission', () => {
  const input = setup();
  input.state.disabled = true;
  input.keydown(key());
  input.send();
  expect(input.submit).not.toHaveBeenCalled();
  input.state.disabled = false;
  input.send();
  expect(input.submit).toHaveBeenCalledOnce();
  input.scope.stop();
});
it('restores draft focus after successful send rendering', async () => {
  const input = setup();
  input.state.sent++;
  expect(input.focus).not.toHaveBeenCalled();
  await nextTick();
  expect(input.focus).toHaveBeenCalledOnce();
  input.scope.stop();
});
