import type { ProviderPort } from '@runnets/application';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  completedRun,
  privateRoot,
  startProviderHost,
  vendorFixture,
  type PrivateRoot,
  type StartedHost,
  type VendorFixture,
} from '../../test-fixtures/local-provider-host.test.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
interface Fixture {
  readonly vendor: VendorFixture;
  readonly profile: PrivateRoot;
  started: StartedHost;
}
async function fixture(envKey = ''): Promise<Fixture> {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', envKey);
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  return { vendor, profile, started };
}
async function restart(f: Fixture): Promise<void> {
  await f.started.stop();
  const next = await startProviderHost(f.profile, { baseUrl: f.vendor.url });
  f.started = next;
  cleanups.push(() => next.stop());
}
function submit(client: StartedHost['client'], f: Fixture, requestId: string) {
  return client.submit({
    workspaceId: 'ws_ocean',
    roomId: f.profile.roomId,
    requestId,
    text: 'provider fixture turn',
  });
}

it('reports an external source, saves an Ocean-managed key and never leaks key bytes', async () => {
  const envKey = 'sk-fixture-environment-key';
  const f = await fixture(envKey);
  const initial = await f.started.client.providerStatus();
  expect(initial).toMatchObject({
    provider: 'deepseek',
    source: 'external',
    state: 'connected',
    model: 'deepseek-flash',
    revision: 0,
    savedKey: false,
    writable: true,
    code: null,
  });
  expect(initial.modelCapabilities).toEqual([
    { model: 'deepseek-flash', imageInput: true },
    { model: 'deepseek-v4-pro', imageInput: false },
  ]);
  const checked = await f.started.client.providerCheck();
  // An external credential has no authoritative metadata row to guard: the result stays transient.
  expect(checked.check).toMatchObject({ outcome: 'ok', httpStatus: 200, persisted: false });
  expect(checked.status.lastCheck).toBeNull();
  expect(f.vendor.requests.filter((r) => r.url === '/models')).toHaveLength(1);
  expect(f.vendor.requests[0]?.authorization).toBe('Bearer ' + envKey);

  const savedKey = 'sk-fixture-saved-key';
  const saved = await f.started.client.providerSet({
    requestId: 'set-1',
    key: savedKey,
    model: 'deepseek-flash',
  });
  expect(saved).toMatchObject({ source: 'saved', state: 'connected', revision: 1, savedKey: true });
  const rechecked = await f.started.client.providerCheck();
  expect(rechecked.check).toMatchObject({ outcome: 'ok', persisted: true });
  expect(rechecked.status.lastCheck).toMatchObject({ outcome: 'ok', modelSupported: true });
  expect(f.vendor.requests.at(-1)?.authorization).toBe('Bearer ' + savedKey);

  const credentialBytes = readFileSync(join(f.profile.credentialDir, 'providers.json'), 'utf8');
  expect(credentialBytes).toContain(savedKey);
  for (const path of ['runtime.sqlite', 'runtime.sqlite-wal']) {
    let bytes = '';
    try {
      bytes = readFileSync(join(f.profile.profile, path), 'utf8');
    } catch {
      continue;
    }
    expect(bytes).not.toContain(savedKey);
    expect(bytes).not.toContain(envKey);
  }
  const transcript = JSON.stringify([initial, checked, saved, rechecked]);
  expect(transcript).not.toContain(savedKey);
  expect(transcript).not.toContain(envKey);
});

it('keeps an explicit disconnect across a restart and blocks environment fallback', async () => {
  const envKey = 'sk-fixture-environment-key';
  const f = await fixture(envKey);
  await f.started.client.providerSet({
    requestId: 'set-1',
    key: 'sk-fixture-saved-key',
    model: 'deepseek-flash',
  });
  const disconnected = await f.started.client.providerDisconnect({
    requestId: 'disconnect-1',
    expectedRevision: 1,
  });
  expect(disconnected).toMatchObject({ source: 'none', state: 'disconnected', revision: 2 });
  await restart(f);
  const after = await f.started.client.providerStatus();
  expect(after).toMatchObject({ source: 'none', state: 'disconnected', revision: 2 });
  await expect(submit(f.started.client, f, 'blocked-turn')).rejects.toThrow('provider_unavailable');
  const unavailable = await f.started.client.providerCheck();
  expect(unavailable.check).toMatchObject({ outcome: 'unavailable', persisted: false });

  const removed = await f.started.client.providerRemoveSavedKey({
    requestId: 'remove-1',
    expectedRevision: 2,
  });
  expect(removed).toMatchObject({ source: 'external', state: 'connected', revision: 3 });
  const receipt = await submit(f.started.client, f, 'env-turn');
  expect(receipt.runId).not.toBeNull();
  expect(await completedRun(f.started.client, f.profile, receipt.runId!)).toMatchObject({
    turnStatus: 'completed',
  });
  expect(f.vendor.requests.filter((r) => r.url === '/chat/completions').at(-1)?.authorization).toBe(
    'Bearer ' + envKey,
  );
});

it('fails closed when the saved secret becomes unreadable instead of using the environment', async () => {
  const envKey = 'sk-fixture-environment-key';
  const f = await fixture(envKey);
  await f.started.client.providerSet({
    requestId: 'set-1',
    key: 'sk-fixture-saved-key',
    model: 'deepseek-flash',
  });
  const credentialFile = join(f.profile.credentialDir, 'providers.json');
  writeFileSync(credentialFile, '{corrupt');
  expect(await f.started.client.providerStatus()).toMatchObject({
    source: 'none',
    state: 'unverified',
    code: 'provider_secret_corrupt',
    savedKey: true,
    revision: 1,
  });
  // A model-only owner action must never drop the unreadable reference and adopt the env key.
  await expect(
    f.started.client.providerSet({ requestId: 'model-only', model: 'deepseek-v4-pro' }),
  ).rejects.toThrow('provider_unverified');
  expect(await f.started.client.providerStatus()).toMatchObject({
    source: 'none',
    state: 'unverified',
    savedKey: true,
    revision: 1,
  });
  expect(readFileSync(credentialFile, 'utf8')).toBe('{corrupt');
  // The ambient key present in the same environment cannot activate or dispatch a turn.
  await expect(submit(f.started.client, f, 'blocked-turn')).rejects.toThrow('provider_unavailable');
  expect(f.vendor.requests).toHaveLength(0);
});

it('keeps provider:null as an explicit force-off even with an ambient environment key', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fixture-ambient-key');
  const started = await startProviderHost(profile, { baseUrl: vendor.url, provider: null });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  expect(await started.client.providerStatus()).toMatchObject({
    source: 'none',
    state: 'absent',
    model: 'deepseek-flash',
    code: null,
    writable: false,
  });
  await expect(
    started.client.providerSet({ requestId: 'forced', key: 'sk-key', model: 'deepseek-flash' }),
  ).rejects.toThrow('provider_unavailable');
  await expect(
    submit(started.client, { profile, vendor, started }, 'forced-off-turn'),
  ).rejects.toThrow('provider_unavailable');
  expect(vendor.requests).toHaveLength(0);
});

it('is idempotent, rejects conflicting payloads and guards stale revisions', async () => {
  const f = await fixture();
  const set = { requestId: 'set-1', key: 'sk-fixture-saved-key', model: 'deepseek-flash' };
  const first = await f.started.client.providerSet(set);
  const replay = await f.started.client.providerSet(set);
  expect(replay).toEqual(first);
  await expect(f.started.client.providerSet({ ...set, model: 'deepseek-v4-pro' })).rejects.toThrow(
    'request_conflict',
  );
  await expect(
    f.started.client.providerDisconnect({ requestId: 'stale', expectedRevision: 0 }),
  ).rejects.toThrow('revision_conflict');
  await expect(
    f.started.client.providerSet({ requestId: 'bad-model', model: 'deepseek-chat' }),
  ).rejects.toThrow('provider_invalid_model');
  await expect(
    f.started.client.providerSet({ requestId: 'bad-key', key: '', model: 'deepseek-flash' }),
  ).rejects.toThrow('invalid_params');
  expect(JSON.stringify({ first, replay })).not.toContain('sk-fixture-saved-key');
});

it('serves reads on a restore-mode maintenance host and refuses every mutation', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fixture-environment-key');
  const started = await startProviderHost(profile, { baseUrl: vendor.url, restore: true });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  const status = await started.client.providerStatus();
  expect(status).toMatchObject({ state: 'restored', source: 'none', writable: false });
  // A restore-mode maintenance host advertises only the read it can actually serve.
  expect(started.host.identity.capabilities).toContain('provider.status');
  for (const refused of [
    'provider.check',
    'provider.set',
    'provider.disconnect',
    'provider.removeSavedKey',
  ])
    expect(started.host.identity.capabilities).not.toContain(refused);
  await expect(
    started.client.providerSet({ requestId: 'set-1', key: 'sk-key', model: 'deepseek-flash' }),
  ).rejects.toThrow('restore_restricted');
  await expect(
    started.client.providerDisconnect({ requestId: 'off', expectedRevision: 0 }),
  ).rejects.toThrow('restore_restricted');
  await expect(started.client.providerCheck()).rejects.toThrow('restore_restricted');
  expect(vendor.requests).toHaveLength(0);
});

it('reports an injected provider as the read-only session activation', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fixture-environment-key');
  const injected: ProviderPort = {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream() {
      yield { type: 'text_delta', text: 'injected answer' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  } as const;
  const started = await startProviderHost(profile, { baseUrl: vendor.url, provider: injected });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  expect(await started.client.providerStatus()).toMatchObject({
    source: 'injected',
    state: 'connected',
    writable: false,
  });
  await expect(
    started.client.providerSet({ requestId: 'x', key: 'sk-key', model: 'deepseek-flash' }),
  ).rejects.toThrow('provider_injected');
  const receipt = await submit(started.client, { profile, vendor, started }, 'injected-turn');
  expect(receipt.runId).not.toBeNull();
  expect(await completedRun(started.client, profile, receipt.runId!)).toMatchObject({
    turnStatus: 'completed',
  });
  expect(vendor.requests).toHaveLength(0);
});
