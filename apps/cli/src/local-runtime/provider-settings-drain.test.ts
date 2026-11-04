import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderConnectionService } from '@runnets/application';
import {
  privateRoot,
  startProviderHost,
  vendorFixture,
} from '../../test-fixtures/local-provider-host.test.js';
import { ProviderSettings } from './provider-settings.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('drains an in-flight owner check and refuses new provider mutations while draining', async () => {
  let settle!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const service = {
    check: () => gate,
    status: () => ({ provider: 'deepseek' }),
  } as unknown as ProviderConnectionService;
  const settings = new ProviderSettings(service);
  const signal = new AbortController().signal;
  const inFlight = settings.dispatch('provider.check', {}, signal);
  let drained = false;
  const drain = settings.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The stop waits for the owner network check instead of discarding it.
  expect(drained).toBe(false);
  expect(await settings.dispatch('provider.check', {}, signal)).toMatchObject({
    error: { code: 'runtime_draining' },
  });
  expect(await settings.dispatch('provider.status', {}, signal)).toEqual({
    result: { provider: 'deepseek' },
  });
  settle({ outcome: 'ok', httpStatus: 200, models: [] });
  await drain;
  expect(drained).toBe(true);
  expect(await inFlight).toMatchObject({ result: { outcome: 'ok' } });
});

it('waits for an in-flight owner check before a graceful stop reports complete', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fixture-environment-key');
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(async () => {
    await vendor.close();
    profile.dispose();
  });
  vendor.holdModels();
  const check = started.client.providerCheck();
  await vi.waitFor(() =>
    expect(vendor.requests.filter((request) => request.url === '/models')).toHaveLength(1),
  );
  let stopped: unknown;
  const stop = started.host.stop().then((value) => {
    stopped = value;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The drain supervision keeps the stop open for the owner network check.
  expect(stopped).toBeUndefined();
  vendor.releaseModels();
  expect(await stop).toMatchObject({ outcome: 'complete', state: 'stopped' });
  expect(await check).toMatchObject({ check: { outcome: 'ok', httpStatus: 200 } });
});
