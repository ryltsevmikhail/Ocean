import { expect, it, vi } from 'vitest';
import type { Runtime } from '../runtime.js';
import { failedStartupDrain } from './service-drain.js';
it('failed startup keeps store ownership until actual metadata cleanup settles', async () => {
  let release!: () => void;
  const held = new Promise<'settled'>((resolve) => {
    release = () => resolve('settled');
  });
  const close = vi.fn();
  const runtime = { services: { drain: () => held }, close } as unknown as Runtime;
  await expect(failedStartupDrain(runtime, 20)).rejects.toThrow('stop_incomplete');
  expect(close).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it('unknown startup cleanup never closes the authoritative store', async () => {
  const close = vi.fn();
  const runtime = { services: { drain: async () => 'uncertain' }, close } as unknown as Runtime;
  await expect(failedStartupDrain(runtime, 20)).rejects.toThrow('stop_incomplete');
  expect(close).not.toHaveBeenCalled();
});
