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

it.each([{ text: '--help' }, { text: '-V' }, { attachments: ['invalid-file-id'] }])(
  'rejects an invalid send before IPC, including on an explicit retry (%j)',
  async (invalid) => {
    const request = channel();
    for (const retry of [false, true]) {
      await expect(submitDraft({ ...command, ...invalid }, retry)).rejects.toMatchObject({
        message: 'invalid_request',
        stage: 'validation',
      });
      expect(request).not.toHaveBeenCalled();
    }
  },
);
it('does not infer a local validation failure from an IPC rejection with the same message', async () => {
  const request = channel();
  const ambiguous = Error('invalid_request');
  request.mockRejectedValueOnce(ambiguous);
  await expect(submitDraft(command, false)).rejects.toBe(ambiguous);
  expect(request.mock.calls).toEqual([[command]]);
});
