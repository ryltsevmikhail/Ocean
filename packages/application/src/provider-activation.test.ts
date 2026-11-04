import { expect, it } from 'vitest';
import { DirectChatService } from './direct-chat.js';
import { activationFixture } from '../test-fixtures/provider-activation.js';

it('persists one activation before dispatch and bypasses its resolver on replay and conflict', async () => {
  const f = activationFixture();
  const chat = new DirectChatService(f);
  const input = { ...f.request, resolver: f.resolver };
  const admitted = chat.submit(input);
  expect(admitted.ok).toBe(true);
  expect(f.calls()).toBe(0);
  const saved = f.store.atomic((tx) => tx.chatTurns()[0]);
  expect(saved?.activation).toEqual(f.snapshot);
  expect(saved?.modelBinding).toEqual({ connectionId: 'legacy:scripted', modelId: 'scripted' });
  expect(chat.submit(input, 'existing_only').ok).toBe(true);
  expect(chat.submit({ ...input, text: 'conflict' })).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  expect(f.resolutions()).toBe(1);
  if (admitted.ok) await admitted.value.completion;
  expect(f.calls()).toBe(1);
});

it('rejects ambiguous or missing provider modes before dispatch', async () => {
  const f = activationFixture();
  const chat = new DirectChatService(f);
  const ambiguous = chat.submit({
    ...f.request,
    resolver: f.resolver,
    provider: f.provider,
  } as never);
  if (ambiguous.ok) await ambiguous.value.completion?.catch(() => {});
  expect(ambiguous).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(chat.submit(f.request as never)).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  });
  expect(f.calls()).toBe(0);
});

it('rolls back a failed admission commit without exposing or dispatching its capture', async () => {
  const f = activationFixture();
  let reject = true;
  const store = {
    atomic: <T>(work: Parameters<typeof f.store.atomic<T>>[0]): T =>
      f.store.atomic((tx) => {
        const result = work(tx);
        if (reject) throw Error('commit refused');
        return result;
      }),
  };
  const chat = new DirectChatService({ ...f, store });
  expect(() => chat.submit({ ...f.request, resolver: f.resolver })).toThrow('commit refused');
  expect(f.store.atomic((tx) => tx.chatTurns())).toEqual([]);
  expect(f.store.atomic((tx) => tx.history(f.request.roomId, 0, 10))).toEqual([]);
  expect(f.calls()).toBe(0);
  reject = false;
  const result = chat.submit({ ...f.request, resolver: f.resolver });
  if (!result.ok) throw Error('admission');
  await result.value.completion;
  expect(f.resolutions()).toBe(2);
  expect(f.calls()).toBe(1);
});
it('refuses a missing production binding without messages, turns or receipt writes', () => {
  const f = activationFixture();
  const store = {
    atomic: <T>(work: Parameters<typeof f.store.atomic<T>>[0]): T =>
      f.store.atomic((tx) => work({ ...tx, modelBinding: () => null })),
  };
  const result = new DirectChatService({ ...f, store }).submit({
    ...f.request,
    resolver: f.resolver,
  });
  expect(result).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
  expect(f.resolutions()).toBe(0);
  expect(
    f.store.atomic((tx) => [
      tx.chatTurns(),
      tx.history(f.request.roomId, 0, 10),
      tx.receipt('turn'),
    ]),
  ).toEqual([[], [], null]);
});
it.each(['accepted', 'dispatching'] as const)(
  'recovers historical %s work without activation or redispatch',
  async (status) => {
    const f = activationFixture();
    f.store.atomic((tx) =>
      tx.putChatTurn({
        id: 'historic_turn',
        workspaceId: f.request.workspaceId,
        roomId: f.request.roomId,
        requestId: 'historic',
        taskRunId: 'tr_historic_turn',
        inboundMessageId: 'historic_inbound',
        readThroughSeq: 1,
        bot: f.bot,
        status,
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
      }),
    );
    await new DirectChatService(f).recover();
    expect(f.resolutions()).toBe(0);
    expect(f.calls()).toBe(0);
    expect(f.store.atomic((tx) => tx.chatTurn('historic_turn')?.status)).toBe(
      status === 'accepted' ? 'failed' : 'uncertain',
    );
  },
);
