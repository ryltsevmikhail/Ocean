import { afterEach, expect, it, vi } from 'vitest';
import { createConnectionSettings } from './model-connection-state.js';
import type { LocalModelConnectionMetadata, LocalModelPendingRequest } from '../model-protocol.js';
afterEach(() => vi.unstubAllGlobals());
it.each(['provider.set', 'modelConnections.set'] as const)(
  'resupplies exact credential bytes for %s through state and bridge',
  async (method) => {
    const input = {
      connectionId: 'legacy:deepseek',
      requestId: 'original',
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
            input: { requestId: 'original', model: 'deepseek-flash' },
            keyWasSupplied: true,
          }
        : { method, input, keyWasSupplied: true };
    const entry: LocalModelConnectionMetadata = {
      connectionId: input.connectionId,
      providerId: input.providerId,
      kind: input.kind,
      endpoint: input.endpoint,
      auth: input.auth,
      defaultModelId: input.defaultModelId,
      revision: 1,
      configuration: {
        intent: 'pending',
        savedKeyReferencePresent: true,
        configuredAfterRestore: true,
      },
      models: [],
      lastCheck: null,
      localQualification: null,
      recovery: {
        kind: 'retry_available',
        pendingRevision: 1,
        request: { version: 1, operation },
        requiresKeyResupply: true,
      },
      writable: true,
      restriction: null,
    };
    const sent: unknown[] = [];
    vi.stubGlobal('window', {
      ocean: {
        request: async (c: { op: string }) => {
          sent.push(structuredClone(c));
          if (c.op === 'model-connections')
            return {
              version: 1,
              ok: true,
              data: { version: 1, workspaceId: 'ws_ocean', items: [entry], nextAfter: null },
            };
          if (c.op === 'model-presets') return { version: 1, ok: true, data: [] };
          return { version: 1, ok: false, error: { code: 'request_conflict' } };
        },
      },
    });
    const s = createConnectionSettings();
    await s.load();
    s.select(entry.connectionId);
    s.key.value = '  original-byte-key  ';
    const recovering = s.recover();
    expect(s.key.value).toBe('');
    await recovering;
    expect(
      sent.find(
        (c) =>
          (c as { op: string }).op === (method === 'provider.set' ? 'provider-set' : 'model-set'),
      ),
    ).toEqual(
      method === 'provider.set'
        ? {
            op: 'provider-set',
            requestId: 'original',
            model: 'deepseek-flash',
            key: '  original-byte-key  ',
          }
        : { op: 'model-set', input: { ...input, key: '  original-byte-key  ' } },
    );
  },
);
