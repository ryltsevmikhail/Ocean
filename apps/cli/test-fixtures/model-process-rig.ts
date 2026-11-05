import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalRuntimeIdentity } from '@runnets/contracts';
import { child } from './model-process-rpc.ts';
import { ownFixture } from './model-process-lifecycle.ts';
import type { PortSnapshot } from './model-process-ports.ts';
export const setInput = {
  connectionId: 'named',
  requestId: 'set',
  expectedRevision: null,
  providerId: 'deepseek',
  kind: 'cloud' as const,
  endpoint: 'https://api.deepseek.com',
  auth: 'api_key' as const,
  defaultModelId: 'deepseek-flash',
  key: 'synthetic-fixture-key',
};
export async function rig(mode: 'standard' | 'mixed' = 'standard') {
  const root = mkdtempSync(join(process.argv[3] ?? tmpdir(), 'oa-m-'));
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', NO_COLOR: '1', NODE_NO_WARNINGS: '1' };
  for (const [key, name] of Object.entries({
    HOME: 'h',
    XDG_CONFIG_HOME: 'c',
    XDG_DATA_HOME: 'd',
    XDG_CACHE_HOME: 'k',
    XDG_STATE_HOME: 's',
    XDG_RUNTIME_DIR: 'r',
    TMPDIR: 't',
    PATH: 'empty',
  })) {
    env[key] = join(root, name);
    mkdirSync(env[key]!, { mode: 0o700 });
  }
  const children: ReturnType<typeof child>[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const c of [...children].reverse()) await c.kill();
      rmSync(root, { recursive: true, force: true });
    })());
  ownFixture(close);
  const profile = join(root, 'p');
  const seed = child('model-process-seed.test.ts', [profile], env);
  children.push(seed);
  const seeded = (await seed.ready.catch(async (error: unknown) => {
    await seed.kill();
    rmSync(root, { recursive: true, force: true });
    throw error;
  })) as {
    botId: string;
    roomId: string;
    profile: string;
    runs: Record<string, string>;
  };
  await seed.kill();
  const launch = async (intercept = false, atProfile = profile) => {
    const owner = child(
      mode === 'mixed' ? 'model-mixed-owner.test.ts' : 'model-process-owner.test.ts',
      [
        atProfile,
        join(root, 'credentials'),
        intercept ? (mode === 'mixed' ? 'restore' : 'drop') : 'plain',
      ],
      env,
    );
    children.push(owner);
    const ready = (await owner.ready) as {
      pid: number;
      identity: LocalRuntimeIdentity;
      host: string;
      sdk: string;
      store: string;
    };
    for (const path of [ready.host, ready.sdk, ready.store, seeded.profile]) {
      assert.match(path, /\/dist\//);
      assert.doesNotMatch(path, /\/src\//);
    }
    return { ...owner, info: ready, snapshot: () => owner.call<PortSnapshot>('snapshot') };
  };
  const peer = async (mode = 'sdk', atProfile = profile) => {
    const process = child('model-process-client.test.ts', [atProfile, mode], env);
    children.push(process);
    const info = (await process.ready) as {
      pid: number;
      identity: LocalRuntimeIdentity;
      endpoint: string;
      sdk: string;
    };
    assert.match(info.sdk, /\/dist\//);
    const client = new Proxy(
      {},
      { get: (_target, name) => (input: unknown) => process.call(String(name), input) },
    ) as LocalRuntimeClient;
    return {
      ...process,
      info,
      client,
      raw: <T>(method: string, params: unknown = {}) => process.call<T>('raw', { method, params }),
    };
  };
  return {
    root,
    profile,
    env,
    seed: seeded,
    scope: { workspaceId: 'ws_ocean', roomId: seeded.roomId },
    launch,
    peer,
    close,
  };
}
export async function until<T>(fn: () => Promise<T>, valid: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await fn();
    if (valid(value)) return value;
    if (Date.now() >= deadline) throw Error('fixture_deadline');
    await sleep(10);
  }
}
export function effects(snapshot: PortSnapshot) {
  const { read: _read, ...effect } = snapshot.counters;
  return effect;
}
