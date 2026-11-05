import { expect, it, vi } from 'vitest';
import { createConnectionSettings } from './model-connection-state.js';
import type { LocalModelConnectionMetadata } from '../model-protocol.js';
const metadata = (id = 'a'): LocalModelConnectionMetadata => ({
  connectionId: id,
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
});
const page = (items: LocalModelConnectionMetadata[], nextAfter: string | null = null) => ({
  version: 1,
  workspaceId: 'ws_ocean',
  items,
  nextAfter,
});
it('loads all short pages without checking connections or inferring a binding', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata('a')], 'a'))
    .mockResolvedValueOnce(page([metadata('b')]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  expect(s.connections.value.map((x) => x.connectionId)).toEqual(['a', 'b']);
  expect(request.mock.calls.map((x) => x[0].op)).toEqual([
    'model-connections',
    'model-connections',
    'model-presets',
  ]);
});
it('rejects a nonprogressing cursor and keeps edits blocked', async () => {
  const request = vi.fn().mockResolvedValueOnce(page([metadata('a')], 'wrong'));
  const s = createConnectionSettings(request);
  await s.load();
  expect(s.stale.value).toBe(true);
  expect(s.connections.value).toEqual([]);
});
it('clears a supplied key before await and never retains it in original identity', async () => {
  let reject!: (e: Error) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    )
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  s.draft.auth = 'api_key';
  s.key.value = 'fixture-secret';
  const submitted = s.save();
  expect(s.key.value).toBe('');
  reject(Error('outcome_unknown'));
  await submitted;
  expect(JSON.stringify(s.pending.value)).not.toContain('fixture-secret');
  expect(request.mock.calls.filter((x) => x[0].op === 'model-set')).toHaveLength(1);
  expect(s.pending.value).toMatchObject({
    requiresKey: true,
    command: { op: 'model-set', input: { expectedRevision: 1 } },
  });
});
it('sends auth-none without a dummy key and preserves exact unknown identity on explicit recovery', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  await s.recover();
  const calls = request.mock.calls.filter((x) => x[0].op === 'model-set');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
  expect(calls[0]?.[0].input).not.toHaveProperty('key');
});
it('refreshes conflict snapshots, clears secrets and never blindly resubmits', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('revision_conflict'))
    .mockResolvedValueOnce(page([{ ...metadata(), revision: 8 }]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  expect(s.current.value?.revision).toBe(8);
  expect(s.message.value).toContain('измен');
  expect(request.mock.calls.filter((x) => x[0].op === 'model-set')).toHaveLength(1);
});
it('drops keys immediately on auth, selection and close changes', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata(), metadata('b')]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  s.draft.auth = 'api_key';
  s.key.value = 'secret';
  s.draft.auth = 'none';
  expect(s.key.value).toBe('');
  s.key.value = 'secret';
  s.select('b');
  expect(s.key.value).toBe('');
  s.key.value = 'secret';
  s.close();
  expect(s.key.value).toBe('');
});

it.each(['connection_closed', 'runtime_unreachable', 'runtime_timeout'])(
  'retains the original request after transport failure %s',
  async (code) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([metadata()]))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Error(code))
      .mockResolvedValueOnce(page([metadata()]))
      .mockResolvedValueOnce([]);
    const s = createConnectionSettings(request);
    await s.load();
    s.select('a');
    await s.save();
    expect(s.pending.value?.command.op).toBe('model-set');
    expect(s.canEdit.value).toBe(false);
  },
);
it('does not overwrite a newer selection when a metadata refresh finishes late', async () => {
  let resolve!: (v: ReturnType<typeof page>) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata(), metadata('b')]))
    .mockResolvedValueOnce([])
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  const loading = s.load();
  s.select('b');
  resolve(page([metadata(), metadata('b')]));
  await loading;
  expect(s.selected.value).toBe('b');
  expect(s.draft.connectionId).toBe('b');
});

it('uses exact pending owner metadata and keeps different historical recovery states separate', async () => {
  const original = {
    ...metadata(),
    auth: 'api_key' as const,
    configuration: {
      intent: 'pending' as const,
      savedKeyReferencePresent: true,
      configuredAfterRestore: true,
    },
    recovery: {
      kind: 'retry_available' as const,
      pendingRevision: 1,
      request: {
        version: 1 as const,
        operation: {
          method: 'modelConnections.set' as const,
          input: {
            connectionId: 'a',
            requestId: 'original-uuid',
            expectedRevision: null,
            providerId: 'ollama',
            kind: 'local' as const,
            endpoint: 'http://127.0.0.1:11434',
            auth: 'api_key' as const,
            defaultModelId: 'qwen3:1.7b',
          },
          keyWasSupplied: true,
        },
      },
      requiresKeyResupply: true,
    },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([original]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('provider_auth'))
    .mockResolvedValueOnce(page([original]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  s.key.value = 'same-original-key';
  await s.recover();
  expect(request.mock.calls[2]?.[0]).toEqual({
    op: 'model-set',
    input: { ...original.recovery.request.operation.input, key: 'same-original-key' },
  });
  expect(s.key.value).toBe('');
  expect(s.canEdit.value).toBe(false);
});

it('keeps new and existing connection writes disabled on a restored read-only host', async () => {
  const entry = { ...metadata(), writable: false, restriction: 'restore_restricted' as const };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([entry]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('');
  s.draft.connectionId = 'new';
  s.key.value = 'synthetic';
  await s.save();
  expect(s.canEdit.value).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  s.select('a');
  await s.revisionAction('model-remove-key');
  expect(request).toHaveBeenCalledTimes(2);
});

it('changes a connection default without sending any bot-binding mutation', async () => {
  const entry = metadata();
  const status = {
    connectionId: 'a',
    providerId: 'ollama',
    kind: 'local',
    endpoint: entry.endpoint,
    auth: 'none',
    defaultModelId: 'explicit-new-default',
    source: 'auth_none',
    state: 'connected',
    models: [],
    revision: 2,
    savedKey: false,
    writable: true,
    code: null,
    lastCheck: null,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([entry]))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(
      page([{ ...entry, defaultModelId: 'explicit-new-default', revision: 2 }]),
    )
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  s.draft.defaultModelId = 'explicit-new-default';
  await s.save();
  expect(request.mock.calls.filter((x) => x[0].op === 'model-set')).toHaveLength(1);
  expect(
    request.mock.calls.filter(
      (x) => x[0].op === 'bot-binding-set' || x[0].op === 'bot-bound-create',
    ),
  ).toEqual([]);
  expect(s.current.value?.defaultModelId).toBe('explicit-new-default');
});
