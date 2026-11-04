import { describe, expect, it } from 'vitest';
import { admitChat } from './direct-chat-admission.js';
import { resolveOk, resolverStub, tinyImage } from '../test-fixtures/image-content-fakes.js';
import {
  history,
  imageChatFixture as fixture,
  prepared,
  requestId,
} from '../test-fixtures/image-chat.test.js';

const scope = (roomId: string, id: string) => ({
  workspaceId: 'ws_ocean',
  roomId,
  requestId: id,
  text: prepared,
});
const policy = { mode: 'admit' as const, codingAvailable: false };

describe('fresh admission binds the prepared image to its request', () => {
  it('refuses a marker whose preparation request id is not the admitting request id', () => {
    const resolver = resolverStub(resolveOk(tinyImage()));
    const f = fixture(resolver);
    const refused = admitChat(f.deps, scope(f.flashRoom.id, 'other-request'), f.provider, policy);
    expect(refused).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
    // Zero writes, zero provider effects, and no resolver work for a mismatched identity.
    expect(history(f, f.flashRoom.id)).toHaveLength(0);
    expect(f.store.atomic((tx) => tx.activeChatTurn(f.flashRoom.id))).toBeNull();
    expect(f.provider.requests).toHaveLength(0);
    expect(resolver.requests).toHaveLength(0);
    // The room is not poisoned: the matching request id is still admitted afterwards.
    const admitted = admitChat(f.deps, scope(f.flashRoom.id, requestId), f.provider, policy);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok || 'record' in admitted.value) throw Error('expected admitted turn');
    expect(admitted.value.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(resolver.requests).toHaveLength(1);
    expect(history(f, f.flashRoom.id)).toHaveLength(1);
  });

  it('still reconstructs a persisted image under a different later admission request id', () => {
    const resolver = resolverStub(resolveOk(tinyImage()));
    const f = fixture(resolver);
    const first = admitChat(f.deps, scope(f.flashRoom.id, requestId), f.provider, policy);
    if (!first.ok || 'record' in first.value) throw Error('first admission');
    f.store.atomic((tx) => {
      const turn = tx.chatTurn(first.value.turn.id);
      if (turn === null) throw Error('turn');
      tx.putChatTurn({ ...turn, status: 'completed' });
    });
    const later = admitChat(
      f.deps,
      { workspaceId: 'ws_ocean', roomId: f.flashRoom.id, requestId: 'later-turn', text: 'ещё?' },
      f.provider,
      policy,
    );
    expect(later.ok).toBe(true);
    // Only the historical persisted message needed the resolver.
    expect(resolver.requests.map((entry) => entry.phase)).toEqual(['committing', 'persisted']);
  });
});
