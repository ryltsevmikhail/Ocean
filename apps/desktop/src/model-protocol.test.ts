import { expect, it, vi } from 'vitest';
import { commands, outputs } from './protocol.js';
import { dispatch } from './host/runtime-client.js';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
it('exposes independent negotiated support through a bounded projection', async () => {
  const client = {
    identity: { capabilities: ['model.connections-v1'] },
  } as unknown as LocalRuntimeClient;
  expect(await dispatch(client, { op: 'model-support' } as never)).toEqual({ connections: true });
  expect(commands.safeParse({ op: 'model-support' }).success).toBe(true);
  expect(outputs['model-support'].safeParse({ connections: true, key: 'leak' }).success).toBe(
    false,
  );
});
it('validates closed public requests with exact 256 UTF8 byte IDs and fixed workspace', () => {
  const c = {
    op: 'model-set',
    input: {
      connectionId: 'я'.repeat(128),
      requestId: 'id',
      expectedRevision: null,
      providerId: 'local',
      kind: 'local',
      endpoint: 'http://127.0.0.1:8080',
      auth: 'none',
      defaultModelId: 'm',
    },
  };
  expect(commands.safeParse(c).success).toBe(true);
  expect(
    commands.safeParse({ ...c, input: { ...c.input, connectionId: 'я'.repeat(129) } }).success,
  ).toBe(false);
  expect(commands.safeParse({ ...c, input: { ...c.input, key: 'secret' } }).success).toBe(false);
  expect(
    commands.safeParse({ op: 'bound-bots', input: { workspaceId: 'elsewhere' } }).success,
  ).toBe(false);
});
it('forwards exact public model mutation inputs without adding authority fields', async () => {
  const setModelConnection = vi.fn().mockResolvedValue('result');
  const input = {
    connectionId: 'c',
    requestId: 'original',
    expectedRevision: null,
    providerId: 'p',
    kind: 'local' as const,
    endpoint: 'http://127.0.0.1:8080',
    auth: 'none' as const,
    defaultModelId: 'm',
  };
  expect(
    await dispatch(
      {
        setModelConnection,
        identity: { capabilities: ['model.connections-v1'] },
      } as unknown as LocalRuntimeClient,
      { op: 'model-set', input } as never,
    ),
  ).toBe('result');
  expect(setModelConnection).toHaveBeenCalledExactlyOnceWith(input);
});

it('refuses negotiated commands on safe old hosts before invoking a model method', async () => {
  const listModelConnections = vi.fn();
  const client = {
    identity: { capabilities: [] },
    listModelConnections,
  } as unknown as LocalRuntimeClient;
  await expect(() =>
    dispatch(client, { op: 'model-connections', input: { workspaceId: 'ws_ocean' } }),
  ).rejects.toThrow('model_runtime_upgrade_required');
  expect(listModelConnections).not.toHaveBeenCalled();
});

it('rejects secret-bearing, coerced and unknown recovery metadata at the desktop boundary', () => {
  const item = {
    connectionId: 'a',
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
    revision: 1,
    configuration: {
      intent: 'active',
      savedKeyReferencePresent: false,
      configuredAfterRestore: true,
    },
    models: [],
    lastCheck: null,
    localQualification: null,
    recovery: null,
    writable: true,
    restriction: null,
  };
  const page = (entry: unknown) => ({
    version: 1,
    workspaceId: 'ws_ocean',
    items: [entry],
    nextAfter: null,
  });
  expect(outputs['model-connections'].safeParse(page(item)).success).toBe(true);
  for (const change of [
    { key: 'secret' },
    { auth: ['none'] },
    { kind: { toString: () => 'local' } },
    { writable: 1 },
    { configuration: { ...item.configuration, savedKeyReferencePresent: 'false' } },
    {
      recovery: {
        kind: 'retry_available',
        pendingRevision: 1,
        request: { version: 2, operation: {} },
        requiresKeyResupply: false,
      },
    },
  ]) {
    expect(outputs['model-connections'].safeParse(page({ ...item, ...change })).success).toBe(
      false,
    );
  }
});
