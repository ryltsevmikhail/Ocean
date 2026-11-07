import { expect, it, vi } from 'vitest';
import { createCreationState } from './creation-state.js';
import type { RoomCreateDraft } from './room-create.js';
const draft: RoomCreateDraft = {
  dialog: 'bot',
  kind: 'direct',
  selected: [],
  title: '',
  handle: 'dev',
  name: 'Dev',
  role: 'Role',
  model: '',
  binding: { connectionId: 'a', modelId: 'm' },
};
it('retains only the original keyless creation and explicitly recovers after a read', async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(Error('connection_closed'))
    .mockResolvedValueOnce(null);
  const read = vi.fn().mockResolvedValue(undefined);
  const s = createCreationState(submit, read);
  await s.submit(draft);
  expect(s.pending.value?.binding).toEqual(draft.binding);
  expect(read).toHaveBeenCalledOnce();
  await s.submit({ ...draft, handle: 'other' });
  expect(submit).toHaveBeenCalledOnce();
  await s.recover();
  expect(submit.mock.calls[0]?.[0]).toEqual(submit.mock.calls[1]?.[0]);
  expect(s.pending.value).toBeNull();
});
it('blocks recovery until failed metadata refresh succeeds', async () => {
  const submit = vi.fn().mockRejectedValue(Error('outcome_unknown'));
  const read = vi
    .fn()
    .mockRejectedValueOnce(Error('runtime_unreachable'))
    .mockResolvedValue(undefined);
  const s = createCreationState(submit, read);
  await s.submit(draft);
  await s.recover();
  expect(submit).toHaveBeenCalledOnce();
  await s.refresh();
  await s.recover();
  expect(submit).toHaveBeenCalledTimes(2);
});

it('keeps the explicitly bound creation family and choice through uncertain recovery', async () => {
  const { modelSupport } = await import('./model-support.js');
  modelSupport.value = true;
  const send = vi.fn().mockRejectedValueOnce(Error('outcome_unknown')).mockResolvedValueOnce(null),
    read = vi.fn().mockResolvedValue(undefined);
  const s = createCreationState(send, read);
  await s.submit(draft);
  modelSupport.value = false;
  await s.recover();
  expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
  expect(send.mock.calls[1]?.[0].binding).toEqual(draft.binding);
  modelSupport.value = null;
});
