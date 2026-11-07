import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createProviderSecretStore } from '@runnets/tools-node';
import type { ChatTurn } from '@runnets/domain';
import { setTimeout as sleep } from 'node:timers/promises';
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
async function until(condition: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await sleep(25);
  }
  throw Error('timeout waiting for ' + label);
}
interface Fixture {
  readonly vendor: VendorFixture;
  readonly profile: PrivateRoot;
  started: StartedHost;
}
async function fixture(): Promise<Fixture> {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  return { vendor, profile, started };
}
const chat = (vendor: VendorFixture) =>
  vendor.requests.filter((request) => request.url === '/chat/completions');
function submit(f: Fixture, requestId: string) {
  return f.started.client.submit({
    workspaceId: 'ws_ocean',
    roomId: f.profile.roomId,
    requestId,
    text: 'rotation fixture turn',
  });
}
const KEY_A = 'sk-fixture-key-a';
const KEY_B = 'sk-fixture-key-b';

it('keeps an admitted turn on its captured key when the saved key rotates mid-flight', async () => {
  const f = await fixture();
  await f.started.client.providerSet({ requestId: 'set-a', key: KEY_A, model: 'deepseek-flash' });
  f.vendor.hold();
  const first = await submit(f, 'turn-1');
  expect(first.runId).not.toBeNull();
  await until(() => chat(f.vendor).length === 1, 'the admitted provider request');
  expect(chat(f.vendor)[0]?.authorization).toBe('Bearer ' + KEY_A);
  expect(savedTurn(f, first.runId!).activation).toMatchObject({
    identity: {
      source: 'connection',
      connectionId: 'legacy:deepseek',
      connectionRevision: 1,
      botProfileVersion: 1,
      modelId: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com',
    },
  });

  // Rotation happens while the admitted turn is still inside its provider call.
  const rotated = await f.started.client.providerSet({
    requestId: 'set-b',
    key: KEY_B,
    model: 'deepseek-flash',
  });
  expect(rotated).toMatchObject({ source: 'saved', state: 'connected', revision: 2 });
  f.vendor.release();
  const settled = await completedRun(f.started.client, f.profile, first.runId!);
  expect(settled.turnStatus).toBe('completed');
  const result = await f.started.client.getResult({
    workspaceId: 'ws_ocean',
    roomId: f.profile.roomId,
    runId: first.runId!,
  });
  expect(result?.body).toBe('fixture answer');
  // The admitted request was not replayed and no request ever used the new key retroactively.
  expect(chat(f.vendor)).toHaveLength(1);
  expect(chat(f.vendor)[0]?.authorization).toBe('Bearer ' + KEY_A);

  const second = await submit(f, 'turn-2');
  expect(await completedRun(f.started.client, f.profile, second.runId!)).toMatchObject({
    turnStatus: 'completed',
  });
  expect(chat(f.vendor)).toHaveLength(2);
  expect(chat(f.vendor)[1]?.authorization).toBe('Bearer ' + KEY_B);
});

it('does not cancel or replay an admitted turn when the owner disconnects', async () => {
  const f = await fixture();
  await f.started.client.providerSet({ requestId: 'set-a', key: KEY_A, model: 'deepseek-flash' });
  f.vendor.hold();
  const first = await submit(f, 'turn-1');
  await until(() => chat(f.vendor).length === 1, 'the admitted provider request');
  const blocked = await f.started.client.providerDisconnect({
    requestId: 'disconnect-1',
    expectedRevision: 1,
  });
  expect(blocked).toMatchObject({ state: 'disconnected', revision: 2 });
  f.vendor.release();
  expect(await completedRun(f.started.client, f.profile, first.runId!)).toMatchObject({
    turnStatus: 'completed',
  });
  expect(chat(f.vendor)).toHaveLength(1);
  await expect(submit(f, 'turn-2')).rejects.toThrow('provider_unavailable');
  expect(chat(f.vendor)).toHaveLength(1);
});

it('keeps the activated configuration across a runtime restart', async () => {
  const f = await fixture();
  await f.started.client.providerSet({ requestId: 'set-a', key: KEY_A, model: 'deepseek-flash' });
  await f.started.client.providerSet({
    requestId: 'set-b',
    key: KEY_B,
    model: 'deepseek-v4-pro',
  });
  await f.started.stop();
  const restarted = await startProviderHost(f.profile, { baseUrl: f.vendor.url });
  f.started = restarted;
  cleanups.push(() => restarted.stop());
  expect(await restarted.client.providerStatus()).toMatchObject({
    source: 'saved',
    state: 'connected',
    model: 'deepseek-v4-pro',
    revision: 2,
  });
  const turn = await restarted.client.submit({
    workspaceId: 'ws_ocean',
    roomId: f.profile.roomId,
    requestId: 'turn-after-restart',
    text: 'restart fixture turn',
  });
  expect(await completedRun(restarted.client, f.profile, turn.runId!)).toMatchObject({
    turnStatus: 'completed',
  });
  const requests = chat(f.vendor);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.authorization).toBe('Bearer ' + KEY_B);
  expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: 'deepseek-flash' });
  expect(savedTurn(f, turn.runId!).activation).toMatchObject({
    identity: {
      modelId: 'deepseek-flash',
      connectionRevision: 2,
      endpoint: 'https://api.deepseek.com',
    },
  });
});

function savedTurn(f: Pick<Fixture, 'profile'>, runId: string): ChatTurn {
  const db = new DatabaseSync(join(f.profile.profile, 'runtime.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT payload FROM ocean_chat_turns WHERE task_run_id=?').get(runId);
    return JSON.parse(String(row?.['payload'])) as ChatTurn;
  } finally {
    db.close();
  }
}
it('replays and conflicts at the host boundary without reading broken saved credentials', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  const secrets = createProviderSecretStore(profile.credentialDir);
  const started = await startProviderHost(profile, { baseUrl: vendor.url, secretStore: secrets });
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  const f = { vendor, profile, started };
  await started.client.providerSet({ requestId: 'set-a', key: KEY_A, model: 'deepseek-flash' });
  const first = await submit(f, 'turn-replay');
  await completedRun(started.client, profile, first.runId!);
  const read = vi.spyOn(secrets, 'read').mockImplementation(() => {
    throw Error('fixture unreadable secret');
  });
  expect(await submit(f, 'turn-replay')).toEqual(first);
  await expect(
    started.client.submit({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId: 'turn-replay',
      text: 'changed',
    }),
  ).rejects.toThrow('request_conflict');
  expect(read).not.toHaveBeenCalled();
  await expect(submit(f, 'new-turn')).rejects.toThrow('provider_unavailable');
  expect(read).toHaveBeenCalledTimes(1);
  expect(chat(vendor)).toHaveLength(1);
});
it('persists explicit injected hosts as source host without a fabricated connection identity', async () => {
  const profile = await privateRoot();
  const started = await startProviderHost(profile, {
    baseUrl: '',
    provider: {
      id: 'deepseek',
      models: ['deepseek-flash'],
      capabilities: { streaming: true, reasoning: false, usage: true },
      async *stream() {
        yield { type: 'text_delta', text: 'injected answer' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      },
    },
  });
  cleanups.push(async () => {
    await started.stop();
    profile.dispose();
  });
  const receipt = await started.client.submit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'injected',
    text: 'hello',
  });
  await completedRun(started.client, profile, receipt.runId!);
  expect(savedTurn({ profile }, receipt.runId!).activation?.identity).toEqual({
    source: 'host',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
  });
});
