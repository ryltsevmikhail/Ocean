import { afterEach, expect, it, vi } from 'vitest';
import { submitDraft } from './bridge.js';
const command = {
  op: 'send' as const,
  room: 'room_a',
  to: 'dev',
  text: 'original',
  requestId: crypto.randomUUID(),
  attachments: [crypto.randomUUID()],
};
const unavailable = {
  version: 1,
  ok: false,
  error: { code: 'attachment_unavailable', sendStage: 'preparation' },
};
function channel() {
  const request = vi.fn<(message: unknown) => Promise<unknown>>();
  vi.stubGlobal('window', { ocean: { request } });
  return request;
}
afterEach(() => vi.unstubAllGlobals());
it('keeps a failed retry unresolved when its scoped receipt is absent', async () => {
  const request = channel();
  request
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValueOnce({ version: 1, ok: true, data: null });
  await expect(submitDraft(command, true)).rejects.toMatchObject({
    stage: 'preparation',
    message: 'attachment_unavailable',
  });
  expect(request.mock.calls).toEqual([
    [command],
    [{ op: 'receipt', room: 'room_a', requestId: command.requestId }],
  ]);
});
it.each(['preparation', 'refused'])(
  'never turns a %s binding conflict into a successful lookup',
  async (sendStage) => {
    const request = channel();
    request.mockResolvedValueOnce({
      version: 1,
      ok: false,
      error: { code: 'request_conflict', sendStage },
    });
    await expect(submitDraft(command, true)).rejects.toMatchObject({
      stage: sendStage,
      message: 'request_conflict',
    });
    expect(request.mock.calls).toEqual([[command]]);
  },
);
it('reports first-attempt preparation failures without a receipt lookup', async () => {
  const request = channel();
  request.mockResolvedValueOnce(unavailable);
  await expect(submitDraft(command, false)).rejects.toMatchObject({
    stage: 'preparation',
    message: 'attachment_unavailable',
  });
  expect(request.mock.calls).toEqual([[command]]);
});
