import { describe, expect, it } from 'vitest';
import { admitChat } from './direct-chat-admission.js';
import { roomContext } from './room-context.js';
import {
  imageContent,
  resolveFail,
  resolveOk,
  resolverStub,
  tinyImage,
} from '../test-fixtures/image-content-fakes.js';
import {
  history,
  imageChatFixture as fixture,
  prepared,
  requestId as preparedRequestId,
} from '../test-fixtures/image-chat.test.js';

describe('direct chat image admission', () => {
  it('admits the vision model with runtime-resolved image parts and zero provider calls', () => {
    const images = resolverStub(resolveOk(tinyImage()));
    const f = fixture(images);
    const admitted = admitChat(
      f.deps,
      {
        workspaceId: 'ws_ocean',
        roomId: f.flashRoom.id,
        requestId: preparedRequestId,
        text: prepared,
      },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok || 'record' in admitted.value) throw Error('expected a turn');
    expect(admitted.value.turn.status).toBe('accepted');
    expect(admitted.value.messages.at(-1)).toEqual({
      role: 'user',
      content: imageContent('Что на изображении?', tinyImage()),
    });
    expect(images.requests).toHaveLength(1);
    expect(images.requests[0]).toMatchObject({ roomId: f.flashRoom.id, phase: 'committing' });
    expect(f.provider.requests).toHaveLength(0);
    // Display history keeps the exact prepared body (marker included) for the Desktop.
    expect(history(f, f.flashRoom.id)[0]?.body).toBe(prepared);
  });

  it('refuses an unsupported selected model before any turn, message or request', () => {
    const images = resolverStub(resolveOk(tinyImage()));
    const f = fixture(images);
    const refused = admitChat(
      f.deps,
      {
        workspaceId: 'ws_ocean',
        roomId: f.proRoom.id,
        requestId: preparedRequestId,
        text: prepared,
      },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'model_image_unsupported' } });
    expect(history(f, f.proRoom.id)).toHaveLength(0);
    expect(f.store.atomic((tx) => tx.activeChatTurn(f.proRoom.id))).toBeNull();
    expect(f.provider.requests).toHaveLength(0);
  });

  it('refuses authority failures with zero writes and zero provider requests', () => {
    for (const code of ['image_unavailable', 'image_too_large'] as const) {
      const f = fixture(resolverStub(resolveFail(code)));
      const refused = admitChat(
        f.deps,
        {
          workspaceId: 'ws_ocean',
          roomId: f.flashRoom.id,
          requestId: preparedRequestId,
          text: prepared,
        },
        f.provider,
        { mode: 'admit', codingAvailable: false },
      );
      expect(refused).toMatchObject({ ok: false, error: { code } });
      expect(history(f, f.flashRoom.id)).toHaveLength(0);
      expect(f.provider.requests).toHaveLength(0);
    }
  });

  it('refuses a forged marker on a host without an image resolver', () => {
    const f = fixture();
    const refused = admitChat(
      f.deps,
      {
        workspaceId: 'ws_ocean',
        roomId: f.flashRoom.id,
        requestId: preparedRequestId,
        text: prepared,
      },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
    expect(history(f, f.flashRoom.id)).toHaveLength(0);
  });

  it('re-resolves and re-validates every historical image on each reconstruction', () => {
    const stub = resolverStub((request) =>
      request.messageId === 'missing' ? resolveFail('image_unavailable') : resolveOk(tinyImage()),
    );
    const f = fixture(stub);
    const first = admitChat(
      f.deps,
      {
        workspaceId: 'ws_ocean',
        roomId: f.flashRoom.id,
        requestId: preparedRequestId,
        text: prepared,
      },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    if (!first.ok || 'record' in first.value) throw Error('first admission');
    const admitted = first.value;
    // Complete the turn so a second model turn is admissible.
    f.store.atomic((tx) => {
      const turn = tx.chatTurn(admitted.turn.id);
      if (turn === null) throw Error('turn');
      tx.putChatTurn({ ...turn, status: 'completed' });
    });
    const second = admitChat(
      f.deps,
      { workspaceId: 'ws_ocean', roomId: f.flashRoom.id, requestId: 'req-2', text: 'а что ещё?' },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    expect(second.ok).toBe(true);
    if (!second.ok || 'record' in second.value || second.value.messages === undefined)
      throw Error('second admission');
    const userMessages = second.value.messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.content).toEqual(imageContent('Что на изображении?', tinyImage()));
    // One resolver call for the historical message, one for the current admitted text.
    expect(stub.requests.map((request) => request.phase)).toEqual(['committing', 'persisted']);
  });

  it('fails the whole turn when a historical image can no longer be reconstructed', () => {
    let failHistory = false;
    const stub = resolverStub((request) =>
      request.phase === 'persisted' && failHistory
        ? resolveFail('image_unavailable')
        : resolveOk(tinyImage()),
    );
    const f = fixture(stub);
    const first = admitChat(
      f.deps,
      {
        workspaceId: 'ws_ocean',
        roomId: f.flashRoom.id,
        requestId: preparedRequestId,
        text: prepared,
      },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    if (!first.ok || 'record' in first.value) throw Error('first admission');
    // Keep the narrowed admission for the callback below (property narrowing
    // does not survive into a nested function).
    const admitted = first.value;
    f.store.atomic((tx) => {
      const turn = tx.chatTurn(admitted.turn.id);
      if (turn === null) throw Error('turn');
      tx.putChatTurn({ ...turn, status: 'completed' });
    });
    failHistory = true;
    const before = history(f, f.flashRoom.id).length;
    const second = admitChat(
      f.deps,
      { workspaceId: 'ws_ocean', roomId: f.flashRoom.id, requestId: 'req-2', text: 'ещё вопрос' },
      f.provider,
      { mode: 'admit', codingAvailable: false },
    );
    expect(second).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
    expect(history(f, f.flashRoom.id)).toHaveLength(before);
    expect(f.provider.requests).toHaveLength(0);
  });
});

describe('room context reconstruction', () => {
  it('keeps system and assistant content as legacy strings while resolving user images', () => {
    const stub = resolverStub(resolveOk(tinyImage()));
    const f = fixture(stub);
    f.store.atomic((tx) => {
      const room = tx.room(f.flashRoom.id)!;
      tx.putMessage({
        id: 'sys-free-user',
        workspaceId: 'ws_ocean',
        roomId: room.id,
        seq: tx.nextSequence(room.id),
        author: 'user',
        targetBotId: f.flash.id,
        body: prepared,
        createdAt: '2026-11-04T00:00:00.000Z',
      });
    });
    const context = f.store.atomic((tx) =>
      roomContext(
        tx,
        tx.room(f.flashRoom.id)!,
        f.flash,
        { text: 'дальше', messageId: 'current', requestId: 'current-request', phase: 'committing' },
        stub,
      ),
    );
    expect(context.ok).toBe(true);
    if (!context.ok) throw Error('context');
    expect(typeof context.value[0]?.content).toBe('string');
    expect(context.value).toHaveLength(3);
    expect(messageTextOf(context.value[1]?.content)).toBe('Что на изображении?');
  });
});

function messageTextOf(content: unknown): string {
  return typeof content === 'string'
    ? content
    : ((content as readonly { type: string; text?: string }[]) ?? [])
        .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
        .join('');
}
