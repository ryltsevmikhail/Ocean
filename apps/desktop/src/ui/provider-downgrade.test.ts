import { afterEach, expect, it, vi } from 'vitest';
import { commands } from '../protocol.js';
import type { LocalModelConnectionMetadata, LocalModelPendingRequest } from '../model-protocol.js';
import { metadata } from '../../test-fixtures/model-settings.js';
const cid = 'legacy:deepseek',
  rawKey = '  original raw key  ';
const status = {
  provider: 'deepseek',
  source: 'saved',
  state: 'connected',
  model: 'deepseek-flash',
  models: ['deepseek-flash'],
  modelCapabilities: [{ model: 'deepseek-flash', imageInput: true }],
  revision: 4,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: null,
};
const ok = (data: unknown) => ({ version: 1, ok: true, data });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(
  method: 'provider.set' | 'provider.removeSavedKey' | 'modelConnections.set',
) {
  vi.resetModules();
  const provider = await import('./provider-state.js'),
    { connectionSettings: s } = await import('./model-connection-state.js'),
    { readModelSupport } = await import('./model-support.js');
  const input = {
    connectionId: cid,
    requestId: 'owner-original',
    expectedRevision: 0,
    providerId: 'deepseek',
    kind: 'cloud' as const,
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key' as const,
    defaultModelId: 'deepseek-flash',
  };
  const operation: LocalModelPendingRequest['operation'] =
    method === 'provider.set'
      ? {
          method,
          input: { requestId: 'owner-original', model: 'deepseek-flash' },
          keyWasSupplied: true,
        }
      : method === 'provider.removeSavedKey'
        ? { method, input: { requestId: 'owner-original', expectedRevision: 0 } }
        : { method, input, keyWasSupplied: true };
  const active: LocalModelConnectionMetadata = {
    ...metadata(cid),
    providerId: 'deepseek',
    kind: 'cloud',
    endpoint: input.endpoint,
    auth: 'api_key',
    defaultModelId: input.defaultModelId,
  };
  let supported = true,
    pending = true,
    writes = 0;
  const sent: ReturnType<typeof commands.parse>[] = [];
  vi.stubGlobal('window', {
    ocean: {
      request: async (raw: unknown) => {
        const c = commands.parse(structuredClone(raw));
        sent.push(c);
        if (c.op === 'model-support') return ok({ connections: supported });
        if (c.op === 'provider') return ok(status);
        if (c.op === 'model-connections')
          return ok({
            version: 1,
            workspaceId: 'ws_ocean',
            items: [
              pending
                ? {
                    ...active,
                    configuration: {
                      intent: 'pending',
                      savedKeyReferencePresent: true,
                      configuredAfterRestore: true,
                    },
                    recovery: {
                      kind: 'retry_available',
                      pendingRevision: 1,
                      request: { version: 1, operation },
                      requiresKeyResupply: method !== 'provider.removeSavedKey',
                    },
                  }
                : active,
              metadata('other'),
              metadata('third'),
            ],
            nextAfter: null,
          });
        if (c.op === 'model-presets') return ok([]);
        if (c.op === 'model-disconnect') {
          return { version: 1, ok: false, error: { code: 'connection_closed' } };
        }
        if (c.op === 'provider-set' || c.op === 'provider-remove-key' || c.op === 'model-set') {
          ++writes;
          if (c.op === 'provider-set' && c.key !== rawKey)
            return { version: 1, ok: false, error: { code: 'request_conflict' } };
          if (writes === 1) {
            pending = false;
            return { version: 1, ok: false, error: { code: 'connection_closed' } };
          }
          return ok(status);
        }
        return { version: 1, ok: false, error: { code: 'invalid_request' } };
      },
    },
  });
  await readModelSupport();
  await s.load();
  s.select(cid);
  if (method !== 'provider.removeSavedKey') s.key.value = rawKey;
  await s.recover();
  const original = s.pending.value;
  s.select('other');
  await s.revisionAction('model-disconnect');
  const other = s.pending.value;
  s.select('third');
  expect(s.canEdit.value).toBe(true);
  supported = false;
  await readModelSupport();
  await provider.loadProviderStatus();
  return { provider, s, sent, original, other };
}
it.each(['provider.set', 'provider.removeSavedKey'] as const)(
  'finishes negotiated %s on a safe old host using the same original only',
  async (method) => {
    const { provider, s, sent, original, other } = await fixture(method);
    const uuid = vi.spyOn(crypto, 'randomUUID');
    provider.providerKey.value = rawKey;
    expect(provider.providerCanSave.value).toBe(false);
    await provider.saveProvider();
    await provider.disconnectProvider();
    await provider.removeSavedProviderKey();
    expect(uuid).not.toHaveBeenCalled();
    expect(
      sent.filter((c) => c.op === 'provider-set' || c.op === 'provider-remove-key'),
    ).toHaveLength(1);
    if (method === 'provider.set') provider.providerKey.value = rawKey;
    const recovering = provider.recoverProvider();
    expect(provider.providerKey.value).toBe('');
    await recovering;
    const writes = sent.filter((c) => c.op === 'provider-set' || c.op === 'provider-remove-key');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(original?.command).toEqual(
      method === 'provider.set'
        ? { op: 'provider-set', requestId: 'owner-original', model: 'deepseek-flash' }
        : { op: 'provider-remove-key', requestId: 'owner-original', expectedRevision: 0 },
    );
    s.select(cid);
    expect(s.pending.value).toBeNull();
    expect(provider.providerPending.value).toBeNull();
    s.select('other');
    expect(s.pending.value).toEqual(other);
  },
);
it('blocks a competing provider write and explains canonical-family incompatibility after downgrade', async () => {
  const { provider, s, sent, original, other } = await fixture('modelConnections.set');
  const before = sent.length;
  const uuid = vi.spyOn(crypto, 'randomUUID');
  provider.providerKey.value = rawKey;
  expect(provider.providerCanSave.value).toBe(false);
  await provider.saveProvider();
  await provider.disconnectProvider();
  await provider.removeSavedProviderKey();
  await provider.recoverProvider();
  expect(uuid).not.toHaveBeenCalled();
  expect(sent.slice(before)).toEqual([]);
  expect(provider.providerMessage.value).toContain('семейство');
  s.select(cid);
  expect(s.pending.value).toEqual(original);
  s.select('other');
  expect(s.pending.value).toEqual(other);
});

it('keeps negotiated ownership on a wrong-key refusal from the old-host completion view', async () => {
  const { provider, s, sent, original } = await fixture('provider.set');
  provider.providerKey.value = 'wrong';
  await provider.recoverProvider();
  s.select(cid);
  expect(s.pending.value).toEqual(original);
  expect(provider.providerPending.value).toEqual(original);
  provider.providerKey.value = rawKey;
  await provider.recoverProvider();
  expect(s.pending.value).toBeNull();
  const writes = sent.filter((c) => c.op === 'provider-set');
  expect(writes.map((c) => c.requestId)).toEqual([
    'owner-original',
    'owner-original',
    'owner-original',
  ]);
});

it('owns a fresh negotiated legacy CID before its reply so downgrade cannot allocate another UUID', async () => {
  vi.resetModules();
  const provider = await import('./provider-state.js'),
    { connectionSettings: s } = await import('./model-connection-state.js'),
    { readModelSupport } = await import('./model-support.js');
  let supported = true,
    lose!: (e: Error) => void;
  const sent: ReturnType<typeof commands.parse>[] = [];
  const active = {
    ...metadata(cid),
    providerId: 'deepseek',
    kind: 'cloud',
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key',
    defaultModelId: 'deepseek-flash',
  };
  vi.stubGlobal('window', {
    ocean: {
      request: async (raw: unknown) => {
        const c = commands.parse(structuredClone(raw));
        sent.push(c);
        if (c.op === 'model-support') return ok({ connections: supported });
        if (c.op === 'provider') return ok(status);
        if (c.op === 'model-connections')
          return supported
            ? ok({ version: 1, workspaceId: 'ws_ocean', items: [active], nextAfter: null })
            : { version: 1, ok: false, error: { code: 'model_runtime_upgrade_required' } };
        if (c.op === 'model-presets') return ok([]);
        if (c.op === 'model-set')
          return new Promise((_, reject) => {
            lose = reject;
          });
        return { version: 1, ok: false, error: { code: 'invalid_request' } };
      },
    },
  });
  await readModelSupport();
  await s.load();
  s.select(cid);
  s.key.value = rawKey;
  const saving = s.save();
  supported = false;
  await readModelSupport();
  await provider.loadProviderStatus();
  const before = sent.length;
  const uuid = vi.spyOn(crypto, 'randomUUID');
  provider.providerKey.value = rawKey;
  await provider.saveProvider();
  await provider.disconnectProvider();
  await provider.removeSavedProviderKey();
  expect(uuid).not.toHaveBeenCalled();
  expect(sent.slice(before)).toEqual([]);
  lose(Error('connection_closed'));
  await saving;
  expect(s.pending.value?.command.op).toBe('model-set');
  expect(provider.providerPending.value).toEqual(s.pending.value);
});
