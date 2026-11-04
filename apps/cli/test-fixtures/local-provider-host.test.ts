/* eslint-disable no-restricted-imports -- Test-only deterministic host fixture for local provider settings. */
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openOceanProfile } from '../src/ocean/profile.js';
import { startLocalRuntime, type LocalRuntimeHost } from '../src/local-runtime/host.js';
import { connectLocalRuntime, localRuntimePaths } from '@runnets/tools-node';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { ProviderPort } from '@runnets/application';

/** Deterministic vendor transport: bounded model list plus a gated chat stream. */
export interface VendorFixture {
  readonly url: string;
  readonly requests: { method: string; url: string; authorization: string }[];
  hold(): void;
  release(): void;
  close(): Promise<void>;
}
export async function vendorFixture(): Promise<VendorFixture> {
  const requests: { method: string; url: string; authorization: string }[] = [];
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '';
      requests.push({
        method: request.method ?? '',
        url,
        authorization: String(request.headers.authorization ?? ''),
      });
      if (url === '/models' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
              { id: 'deepseek-v4-pro', input_modalities: ['text'] },
            ],
          }),
        );
        return;
      }
      if (url === '/chat/completions' && request.method === 'POST') {
        for await (const _chunk of request) void _chunk;
        if (gate !== null) await gate;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'fixture answer' } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release?.();
      release = null;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface PrivateRoot {
  readonly root: string;
  readonly profile: string;
  readonly roomId: string;
  readonly botId: string;
  readonly credentialDir: string;
  dispose(): void;
}
/** Private synthetic HOME/XDG fixture; never the owner's profile or environment. */
export async function privateRoot(): Promise<PrivateRoot> {
  const root = mkdtempSync(join(tmpdir(), 'ocean-provider-'));
  const env: Record<string, string> = {};
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
    env[key] = path;
    vi.stubEnv(key, path);
  }
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const workspaceId = 'ws_ocean';
  const execute = runtime.conversations.execute.bind(runtime.conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId, root });
  const bot = execute({
    type: 'CreateBot',
    workspaceId,
    requestId: 'bot',
    handle: 'dev',
    name: 'Dev',
    role: 'Fixture',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  if (!bot.ok || bot.value.kind !== 'bot') throw Error('fixture bot');
  const room = execute({
    type: 'OpenDirectRoom',
    workspaceId,
    requestId: 'room',
    botId: bot.value.data.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture room');
  runtime.close();
  return {
    root,
    profile,
    roomId: room.value.data.id,
    botId: bot.value.data.id,
    credentialDir: join(root, 'profile.credentials'),
    dispose: () => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export interface StartedHost {
  readonly host: LocalRuntimeHost;
  readonly client: LocalRuntimeClient;
  stop(): Promise<void>;
}
export async function startProviderHost(
  fixture: PrivateRoot,
  options: {
    readonly baseUrl: string;
    readonly restore?: boolean;
    readonly provider?: ProviderPort | null;
  },
): Promise<StartedHost> {
  const host = await startLocalRuntime({
    profile: fixture.profile,
    providerBaseUrl: options.baseUrl,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.restore === true ? { restore: true } : {}),
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
/** Poll the authoritative run snapshot until the turn reaches a terminal phase. */
export async function completedRun(
  client: LocalRuntimeClient,
  fixture: PrivateRoot,
  runId: string,
): Promise<{ turnStatus: string; runId: string }> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = await client.getRun({ workspaceId: 'ws_ocean', roomId: fixture.roomId, runId });
    if (run === null) throw Error('run disappeared');
    if (['completed', 'failed', 'cancelled', 'uncertain'].includes(run.turnStatus)) return run;
    await sleep(25);
  }
  throw Error('turn did not settle');
}
export function requestContext(fixture: PrivateRoot, requestId: string) {
  return {
    workspaceId: 'ws_ocean',
    roomId: fixture.roomId,
    requestId,
    text: 'provider fixture turn',
  };
}
export function runtimeDirectory(fixture: PrivateRoot): string {
  return localRuntimePaths(fixture.profile).directory;
}
