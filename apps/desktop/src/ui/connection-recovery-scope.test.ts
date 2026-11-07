import { expect, it, vi } from 'vitest';
import { createConnectionSettings } from './model-connection-state.js';
import { metadata, page, pendingRemove } from '../../test-fixtures/model-settings.js';
it('finishes B without dropping A lost acknowledgement and permits unrelated B edits', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata(), pendingRemove('b', 'b-original')]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(page([metadata(), pendingRemove('b', 'b-original')]))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({ connectionId: 'b' })
    .mockResolvedValueOnce(page([metadata(), metadata('b')]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  const original = s.pending.value;
  s.select('b');
  await s.recover();
  s.select('a');
  expect(s.pending.value).toEqual(original);
  expect(s.canEdit.value).toBe(false);
  s.select('b');
  expect(s.canEdit.value).toBe(true);
});
it('retains a different original on the same CID and refuses the mismatching advertised operation', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([metadata()]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(page([pendingRemove('a', 'other-request')]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  s.select('a');
  await s.save();
  const original = s.pending.value;
  await s.recover();
  expect(request).toHaveBeenCalledTimes(5);
  expect(s.pending.value).toEqual(original);
});
it.each(['request_conflict', 'revision_conflict'])(
  'does not clear an unknown original on %s during explicit completion',
  async (code) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([metadata()]))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Error('connection_closed'))
      .mockResolvedValueOnce(page([metadata()]))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Error(code))
      .mockResolvedValueOnce(page([metadata()]))
      .mockResolvedValueOnce([]);
    const s = createConnectionSettings(request);
    await s.load();
    s.select('a');
    await s.save();
    const original = s.pending.value;
    await s.recover();
    expect(s.pending.value).toEqual(original);
    await s.save();
    expect(request.mock.calls.filter((x) => x[0].op === 'model-set')).toHaveLength(2);
  },
);
it('retains an absent newly created row as a reachable local original, without fabricating metadata', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('outcome_unknown'))
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  Object.assign(s.draft, {
    connectionId: 'new',
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
  });
  await s.save();
  expect(s.selected.value).toBe('new');
  expect(s.connections.value).toEqual([]);
  expect(s.pending.value?.connectionId).toBe('new');
});
it('selects the competing canonical create target without reapplying the losing draft', async () => {
  const winning = { ...metadata('new'), revision: 7, endpoint: 'http://127.0.0.1:9000' };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(Error('revision_conflict'))
    .mockResolvedValueOnce(page([winning]))
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(request);
  await s.load();
  Object.assign(s.draft, {
    connectionId: 'new',
    providerId: 'ollama',
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434',
    auth: 'none',
    defaultModelId: 'qwen3:1.7b',
  });
  await s.save();
  expect(s.selected.value).toBe('new');
  expect(s.current.value?.revision).toBe(7);
  expect(s.draft.endpoint).toBe(winning.endpoint);
  expect(request.mock.calls.filter((x) => x[0].op === 'model-set')).toHaveLength(1);
});
