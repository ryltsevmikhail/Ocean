import { expect, it } from 'vitest';
import { admitChat } from './direct-chat-admission.js';
import { hostModelActivation } from './model-activation-snapshot.js';
import {
  imageChatFixture,
  prepared,
  requestId,
  history,
} from '../test-fixtures/image-chat.test.js';
import { resolverStub, resolveOk, tinyImage } from '../test-fixtures/image-content-fakes.js';

it('refuses images excluded by the frozen model capabilities despite wider adapter support', () => {
  const f = imageChatFixture(resolverStub(resolveOk(tinyImage())));
  const snapshot = hostModelActivation(f.provider, 'deepseek-flash', f.clock.now().toISOString());
  const result = admitChat(
    f.deps,
    { workspaceId: 'ws_ocean', roomId: f.flashRoom.id, requestId, text: prepared },
    {
      resolver: {
        resolve: () => ({
          ok: true,
          value: {
            provider: f.provider,
            snapshot: {
              ...snapshot,
              capabilities: { ...snapshot.capabilities, inputModalities: ['text'] },
            },
          },
        }),
      },
    },
    { mode: 'admit', codingAvailable: false },
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'model_image_unsupported' } });
  expect(history(f, f.flashRoom.id)).toEqual([]);
  expect(f.provider.requests).toEqual([]);
});
it('records unaddressed group notes without consulting activation', () => {
  const f = imageChatFixture();
  const result = admitChat(
    f.deps,
    { workspaceId: 'ws_ocean', roomId: f.groupRoom.id, requestId: 'note', text: 'note' },
    {
      resolver: {
        resolve: () => {
          throw Error('must bypass');
        },
      },
    },
    { mode: 'admit', codingAvailable: false },
  );
  expect(result).toMatchObject({ ok: true, value: { record: { body: 'note' } } });
});
