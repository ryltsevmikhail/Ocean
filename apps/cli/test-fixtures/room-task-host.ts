/* eslint-disable no-restricted-imports -- CLI fixture imports host module types from its own package. */
import type * as ProfileModule from '../src/ocean/profile.js';
import type * as ActivationFactoryModule from '../src/local-runtime/provider-activation-factory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '@runnets/store-sqlite';
import { ModelConnectionService, unconfiguredModelConnection } from '@runnets/application';
import { createHash } from 'node:crypto';
import { createFetchHttpClient, type HttpRequest } from '@runnets/provider-core';
export async function roomTaskHostFixture(built = false, local = { tools: false }) {
  const { openOceanProfile } = (await import(
    new URL(built ? '../dist/ocean/profile.js' : '../src/ocean/profile.js', import.meta.url).href
  )) as typeof ProfileModule;
  const { createProviderActivationFactory } = (await import(
    new URL(
      built
        ? '../dist/local-runtime/provider-activation-factory.js'
        : '../src/local-runtime/provider-activation-factory.js',
      import.meta.url,
    ).href
  )) as typeof ActivationFactoryModule;
  const root = mkdtempSync(join(tmpdir(), 'room-task-host-'));
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const execute = runtime.conversations.execute.bind(runtime.conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: 'ws_ocean', root });
  const botIds = ['a', 'b'].map((handle) => {
    const result = execute({
      type: 'CreateBot',
      requestId: handle,
      workspaceId: 'ws_ocean',
      handle,
      name: handle,
      role: 'assistant',
      provider: handle === 'a' ? 'deepseek' : 'ollama',
      model: handle === 'a' ? 'deepseek-flash' : 'qwen3:1.7b',
    });
    if (!result.ok || result.value.kind !== 'bot') throw Error('bot fixture');
    return result.value.data.id;
  });
  const room = execute({
    type: 'CreateGroupRoom',
    requestId: 'group',
    workspaceId: 'ws_ocean',
    title: 'Team',
    botIds,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('room fixture');
  const roomId = room.value.data.id;
  runtime.close();
  const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  store.modelConnections.put(
    {
      ...unconfiguredModelConnection('deepseek'),
      connectionId: 'legacy:deepseek',
      revision: 1,
      intent: 'active',
      endpoint: 'https://api.deepseek.com',
      defaultModelId: 'deepseek-flash',
    },
    0,
  );
  const requests: string[] = [];
  const metadata: string[] = [];
  const details = {
    format: 'gguf',
    family: 'qwen3',
    families: ['qwen3'],
    quantization_level: 'Q4_K_M',
    parameter_size: '2.0B',
  };
  const httpClient = createFetchHttpClient(async (url, init) => {
    const path = new URL(url).pathname;
    if (path !== '/api/chat' && path.startsWith('/api/')) {
      metadata.push(path);
      const value = {
        '/api/version': { version: 'fixture-0.1' },
        '/api/tags': {
          models: [
            {
              name: 'qwen3:1.7b',
              model: 'qwen3:1.7b',
              size: 1400000000,
              digest: 'a'.repeat(64),
              details,
            },
          ],
        },
        '/api/show': {
          details,
          capabilities: local.tools ? ['completion', 'tools'] : ['completion'],
          model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
          tensors: [{ name: 'token_embd.weight', type: 'Q4_K', shape: [2048, 151936] }],
        },
      }[path];
      return new Response(JSON.stringify(value));
    }
    if (init.method === 'GET')
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
    const body = String(init.body);
    requests.push(body);
    if (path === '/api/chat')
      return new Response(
        JSON.stringify({
          model: 'qwen3:1.7b',
          message: { role: 'assistant', content: 'B done' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        }) + '\n',
      );
    const delegate = !body.includes('B done');
    const delta = delegate
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'delegate',
              type: 'function',
              function: {
                name: 'room_delegate',
                arguments: JSON.stringify({ toBotId: botIds[1], text: 'ask B' }),
              },
            },
          ],
        }
      : { content: 'A done' };
    return new Response(
      'data: ' +
        JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        '\n\n' +
        'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: delegate ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  const service = new ModelConnectionService({
    store: store.modelConnections,
    secrets: {
      read: () => ({ status: 'absent' }),
      write: () => {
        throw Error('local auth none');
      },
      replace: () => {
        throw Error('local auth none');
      },
      remove: () => {},
    },
    factory: createProviderActivationFactory({ env: {}, httpClient }),
    clock: { now: () => new Date() },
    nextId: () => 'owner-check',
    sha256: (text) => createHash('sha256').update(text).digest('hex'),
  });
  service.set({
    connectionId: 'local:room-b',
    requestId: 'set-local',
    expectedRevision: null,
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
  });
  await service.check('local:room-b');
  store.conversations.atomic((tx) => {
    tx.putModelBinding(botIds[0]!, { connectionId: 'legacy:deepseek', modelId: 'deepseek-flash' });
    tx.putModelBinding(botIds[1]!, { connectionId: 'local:room-b', modelId: 'qwen3:1.7b' });
  });
  store.close();
  return {
    root,
    profile,
    roomId,
    botIds,
    requests,
    metadata,
    httpClient,
    input: {
      workspaceId: 'ws_ocean',
      roomId,
      requestId: 'start',
      text: 'work',
      initialBotIds: [botIds[0]!],
      participants: botIds.map((botId) => ({ botId, grantReferences: [] })),
      mandate: { projectId: null, codingTaskId: null, permissions: [] },
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
export type { HttpRequest };
