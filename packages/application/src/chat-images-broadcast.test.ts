import { describe, expect, it } from 'vitest';
import { imageRefusalCode } from './image-content.js';
import { admitBroadcastChild, nextBroadcastChild } from './room-broadcast-runner.js';
import {
  imageContent,
  resolveOk,
  resolverStub,
  tinyImage,
} from '../test-fixtures/image-content-fakes.js';
import { imageChatFixture as fixture, prepared } from '../test-fixtures/image-chat.test.js';

describe('mixed-capability broadcast', () => {
  it('gives images to the capable recipient and durably refuses the text-only recipient', () => {
    const images = resolverStub(resolveOk(tinyImage()));
    const f = fixture(images);
    const submitted = f.service.submit({
      workspaceId: 'ws_ocean',
      roomId: f.groupRoom.id,
      requestId: 'b-1',
      text: prepared,
    });
    if (!submitted.ok) throw Error('broadcast submit: ' + submitted.error.code);
    const batchId = submitted.value.id;
    // First frozen child: the vision-capable bot receives the actual image parts.
    const next = nextBroadcastChild(f.store, batchId);
    if (next === null) throw Error('first child');
    expect(next.turn.bot.model).toBe('deepseek-flash');
    const admitted = admitBroadcastChild(f.store, batchId, next.turn.id, {
      images,
      guard: (messages) => imageRefusalCode(f.provider, next.turn.bot.model, messages),
    });
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind !== 'admitted') throw Error('admitted');
    expect(admitted.value.messages.at(-1)?.content).toEqual(
      imageContent('Что на изображении?', tinyImage()),
    );
    f.store.atomic((tx) => {
      const turn = tx.chatTurn(next.turn.id);
      if (turn === null) throw Error('turn');
      tx.putChatTurn({ ...turn, status: 'completed' });
    });
    // Second child: a text-only model is refused before any child provider effect.
    const second = nextBroadcastChild(f.store, batchId);
    if (second === null) throw Error('second child');
    expect(second.turn.bot.model).toBe('deepseek-v4-pro');
    const refused = admitBroadcastChild(f.store, batchId, second.turn.id, {
      images,
      guard: (messages) => imageRefusalCode(f.provider, second.turn.bot.model, messages),
    });
    expect(refused).toMatchObject({ kind: 'refused', code: 'model_image_unsupported' });
    const view = f.service.get({ workspaceId: 'ws_ocean', roomId: f.groupRoom.id, batchId });
    expect(view.recipients.map((child) => child.state)).toEqual(['answered', 'refused']);
    expect(view.recipients[1]?.refusalCode).toBe('model_image_unsupported');
    expect(f.provider.requests).toHaveLength(0);
  });
});
