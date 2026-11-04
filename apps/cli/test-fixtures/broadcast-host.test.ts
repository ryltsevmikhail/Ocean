/* eslint-disable no-restricted-imports -- Test-only deterministic host fixture for broadcast tests. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openOceanProfile } from '../src/ocean/profile.js';
import { startLocalRuntime, type LocalRuntimeHost } from '../src/local-runtime/host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { ProviderPort } from '@runnets/application';

export interface BroadcastProfile {
  readonly root: string;
  readonly profile: string;
  readonly roomId: string;
  readonly botIds: readonly string[];
  dispose(): void;
}
/** Private synthetic HOME/XDG profile with two group bots; never the owner's profile. */
export async function broadcastProfile(
  models: readonly [string, string] = ['deepseek-flash', 'deepseek-flash'],
): Promise<BroadcastProfile> {
  const root = mkdtempSync(join(tmpdir(), 'ocean-broadcast-'));
  for (const [key, name] of Object.entries({
    HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    XDG_RUNTIME_DIR: 'run',
    TMPDIR: 'tmp',
  })) {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    vi.stubEnv(key, path);
  }
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fixture-broadcast-key');
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const workspaceId = 'ws_ocean';
  const execute = runtime.conversations.execute.bind(runtime.conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId, root });
  const botIds = ['dev', 'review'].map((handle, index) => {
    const created = execute({
      type: 'CreateBot',
      workspaceId,
      requestId: 'bot-' + handle,
      handle,
      name: handle,
      role: handle === 'dev' ? 'Developer' : 'Reviewer',
      provider: 'deepseek',
      model: models[index] ?? models[0]!,
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('fixture bot');
    return created.value.data.id;
  });
  const room = execute({
    type: 'CreateGroupRoom',
    workspaceId,
    requestId: 'team',
    title: 'Team',
    botIds,
  });
  if (!room.ok || room.value.kind !== 'room' || room.value.data.kind !== 'group')
    throw Error('fixture room');
  runtime.close();
  return {
    root,
    profile,
    roomId: room.value.data.id,
    botIds,
    dispose: () => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export interface StartedBroadcastHost {
  readonly host: LocalRuntimeHost;
  readonly client: LocalRuntimeClient;
  stop(): Promise<void>;
}
export async function startBroadcastHost(
  fixture: BroadcastProfile,
  baseUrl: string,
  provider?: ProviderPort,
): Promise<StartedBroadcastHost> {
  const host = await startLocalRuntime({
    profile: fixture.profile,
    providerBaseUrl: baseUrl,
    ...(provider === undefined ? {} : { provider }),
  });
  const client = await connectLocalRuntime({ profile: fixture.profile });
  return {
    host,
    client,
    async stop() {
      client.close();
      await host.stop();
    },
  };
}
/** Poll the durable batch until it leaves the open state. */
export async function settledBatch(
  client: LocalRuntimeClient,
  fixture: BroadcastProfile,
  batchId: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const batch = await client.broadcastGet({
      workspaceId: 'ws_ocean',
      roomId: fixture.roomId,
      batchId,
    });
    if (batch.state !== 'open' || Date.now() > deadline) return batch;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
