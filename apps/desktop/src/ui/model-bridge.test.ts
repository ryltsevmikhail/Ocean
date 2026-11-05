import { afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { call } from './bridge.js';
import { recoveryCommand } from './model-settings-recovery.js';
import type { LocalModelPendingRequest } from '../model-protocol.js';
afterEach(() => vi.unstubAllGlobals());
it('posts a detached validated descriptor that Electron can structuredClone', async () => {
  const sent: unknown[] = [];
  vi.stubGlobal('window', {
    ocean: {
      request: async (command: unknown) => {
        sent.push(structuredClone(command));
        return { version: 1, ok: false, error: { code: 'revision_conflict' } };
      },
    },
  });
  const input = reactive({
    connectionId: 'a',
    requestId: 'original',
    expectedRevision: null,
    providerId: 'ollama',
    kind: 'local' as const,
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none' as const,
    defaultModelId: 'qwen3:1.7b',
  });
  await expect(call({ op: 'model-set', input })).rejects.toThrow('revision_conflict');
  expect(sent).toEqual([{ op: 'model-set', input: { ...input } }]);
});
it('posts exact legacy recovery from reactive metadata without inventing a revision', async () => {
  const sent: unknown[] = [];
  vi.stubGlobal('window', {
    ocean: {
      request: async (command: unknown) => {
        sent.push(structuredClone(command));
        return { version: 1, ok: false, error: { code: 'provider_auth' } };
      },
    },
  });
  const metadata = reactive<LocalModelPendingRequest>({
    version: 1,
    operation: {
      method: 'provider.set',
      input: { requestId: crypto.randomUUID(), model: 'deepseek-flash' },
      keyWasSupplied: true,
    },
  });
  const command = recoveryCommand(metadata, 'synthetic-key');
  await expect(call(command)).rejects.toThrow('provider_auth');
  expect(sent).toEqual([command]);
  expect(sent[0]).not.toHaveProperty('expectedRevision');
});
