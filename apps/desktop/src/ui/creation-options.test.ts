import { expect, it, vi } from 'vitest';
import { createCreationOptions } from './creation-options.js';
it('does not apply a late old-host result to a reopened bound-bot dialog', async () => {
  let first!: (v: boolean) => void, second!: (v: boolean) => void;
  const support = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          first = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          second = r;
        }),
    );
  const legacy = vi.fn().mockResolvedValue('old-model');
  const connections = vi.fn().mockResolvedValue(undefined);
  const s = createCreationOptions({ support, legacy, connections });
  const old = s.open();
  s.close();
  const current = s.open();
  second(true);
  await current;
  first(false);
  await old;
  expect(s.negotiated.value).toBe(true);
  expect(s.model.value).toBe('');
  expect(legacy).not.toHaveBeenCalled();
});

it('keeps the dialog unavailable if its pinned support changes while metadata is loading', async () => {
  const { modelSupport, pinModelSupport } = await import('./model-support.js');
  modelSupport.value = true;
  let finish!: () => void;
  const s = createCreationOptions({
    support: async () => true,
    connections: () =>
      new Promise((r) => {
        finish = r;
      }),
    legacy: async () => '',
    pin: pinModelSupport,
  });
  const reading = s.open();
  await Promise.resolve();
  modelSupport.value = false;
  finish();
  await reading;
  expect(s.negotiated.value).toBeNull();
  expect(s.message.value).toContain('изменились');
  modelSupport.value = null;
});
