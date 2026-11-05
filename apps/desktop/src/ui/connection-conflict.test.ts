import { expect, it, vi } from 'vitest';
import { createConnectionSettings } from './model-connection-state.js';
import { metadata, page, pendingRemove } from '../../test-fixtures/model-settings.js';
const fill = (s: ReturnType<typeof createConnectionSettings>, id: string) =>
  Object.assign(s.draft, {
    connectionId: id,
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
  });
it('keeps two uncertain connections independently and recovers only the selected one', async () => {
  const all = page([metadata(), metadata('b')]);
  const request = vi
    .fn()
    .mockResolvedValueOnce(all)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(all)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(all)
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  const a = s.pending.value;
  s.select('b');
  await s.save();
  expect(s.pendingEntries.value).toHaveLength(2);
  s.select('a');
  expect(s.pending.value).toEqual(a);
});
it('shows actual absence after a create conflict and blocks editing if refresh fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('revision_conflict'))
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  fill(s, 'new');
  await s.save();
  expect(s.selected.value).toBe('new');
  expect(s.current.value).toBeUndefined();
  expect(s.message.value).toContain('отсутствует');
  const failed = vi
    .fn()
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('revision_conflict'))
    .mockRejectedValueOnce(Error('connection_closed'));
  const f = createConnectionSettings(failed);
  await f.load();
  fill(f, 'new');
  await f.save();
  expect(f.stale.value).toBe(true);
  expect(f.canEdit.value).toBe(false);
  expect(f.message.value).toContain('Чтение не удалось');
});
it('does not send retained A to historical metadata advertising a different request ID', async () => {
  const historical = {
    ...pendingRemove('a', 'two'),
    recovery: { kind: 'original_input_required' as const, pendingRevision: 2, requestId: 'two' },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(page([historical]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  const original = s.pending.value;
  await s.recover();
  expect(s.pending.value).toEqual(original);
  expect(request).toHaveBeenCalledTimes(5);
});

it('retains an advertised pending original after a wrong-key refusal even if the row now has no envelope', async () => {
  const input = {
    connectionId: 'a',
    requestId: 'owner-original',
    expectedRevision: 1,
    providerId: 'ollama',
    kind: 'local' as const,
    endpoint: 'http://127.0.0.1:11434',
    auth: 'api_key' as const,
    defaultModelId: 'qwen3:1.7b',
  };
  const advertised = {
    ...metadata(),
    auth: 'api_key' as const,
    revision: 2,
    configuration: {
      intent: 'pending' as const,
      savedKeyReferencePresent: true,
      configuredAfterRestore: true,
    },
    recovery: {
      kind: 'retry_available' as const,
      pendingRevision: 2,
      request: {
        version: 1 as const,
        operation: { method: 'modelConnections.set' as const, input, keyWasSupplied: true },
      },
      requiresKeyResupply: true,
    },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([advertised]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('request_conflict'))
    .mockResolvedValueOnce(page([{ ...metadata(), revision: 3 }]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  s.key.value = 'wrong';
  await s.recover();
  expect(s.pending.value?.command).toEqual({ op: 'model-set', input });
  expect(s.canEdit.value).toBe(false);
});
