import { expect, it } from 'vitest';
import { parseBroadcastPrompt } from './broadcast-prompt.js';

it('parses explicit broadcast actions without stealing ordinary message text', () => {
  expect(parseBroadcastPrompt('/broadcast')).toEqual({ kind: 'show' });
  expect(parseBroadcastPrompt('/broadcast show')).toEqual({ kind: 'show' });
  expect(parseBroadcastPrompt('/broadcast continue batch_1 2')).toEqual({
    kind: 'vote',
    action: 'continue',
    batchId: 'batch_1',
    expectedRevision: 2,
  });
  expect(parseBroadcastPrompt('/broadcast abandon batch_1 5')).toEqual({
    kind: 'vote',
    action: 'abandon',
    batchId: 'batch_1',
    expectedRevision: 5,
  });
  expect(parseBroadcastPrompt('/broadcast continue our discussion')).toEqual({
    kind: 'submit',
    text: 'continue our discussion',
  });
  expect(parseBroadcastPrompt('/broadcast continue batch_1 not-a-revision')).toEqual({
    kind: 'submit',
    text: 'continue batch_1 not-a-revision',
  });
  expect(parseBroadcastPrompt('/broadcast show me the plan')).toEqual({
    kind: 'submit',
    text: 'show me the plan',
  });
  expect(parseBroadcastPrompt('/broadcast Вопрос всем')).toEqual({
    kind: 'submit',
    text: 'Вопрос всем',
  });
  expect(parseBroadcastPrompt('/broadcast   ')).toEqual({ kind: 'show' });
  expect(parseBroadcastPrompt('ordinary message')).toBeNull();
  expect(parseBroadcastPrompt('/broadcasts')).toBeNull();
});
