import { expect, it } from 'vitest';
import type { LocalRuntimeIdentity } from '@runnets/contracts';
import { localRoomClient } from './local-room-client.js';

const scope = { workspaceId: 'ws', roomId: 'room' };
const ordinary = {
  ...scope,
  id: 'reply_turn',
  seq: 1,
  author: 'bot',
  authorBotId: 'a',
  targetBotId: 'a',
  turnId: 'turn',
  createdAt: '2026-11-06T00:00:00Z',
  bodyBase64: 'aGVsbG8=',
};
const peer = { ...ordinary, id: 'peer', targetBotId: 'b' };
function client(value: unknown, addressed = true) {
  const identity: LocalRuntimeIdentity = {
    protocol: 1,
    instanceId: 'instance',
    profileId: 'profile',
    capabilities: ['status', 'stop', ...(addressed ? ['room.addressed-history-v1'] : [])],
  };
  return localRoomClient(async () => value, identity);
}
it('decodes distinct bot author and recipient only with returned addressed-history support', async () => {
  await expect(client([peer]).history(scope)).resolves.toEqual([
    {
      ...scope,
      id: 'peer',
      seq: 1,
      author: 'bot',
      authorBotId: 'a',
      targetBotId: 'b',
      turnId: 'turn',
      createdAt: ordinary.createdAt,
      body: 'hello',
    },
  ]);
  await expect(client([peer], false).history(scope)).rejects.toThrow('invalid_frame');
});
it.each([false, true])('preserves ordinary and user history with support=%s', async (modern) => {
  const user = {
    ...scope,
    id: 'user',
    seq: 2,
    author: 'user',
    targetBotId: null,
    createdAt: ordinary.createdAt,
    bodyBase64: '77u/aGk=',
  };
  const decoded = await client([ordinary, user], modern).history(scope);
  expect(decoded).toMatchObject([
    { author: 'bot', authorBotId: 'a', targetBotId: 'a', body: 'hello' },
    { author: 'user', targetBotId: null, body: '\uFEFFhi' },
  ]);
  await expect(
    client([{ ...user, authorBotId: 'a' }], modern).history({ ...scope, after: 1 }),
  ).rejects.toThrow('invalid_frame');
});
it.each([
  { targetBotId: null },
  { targetBotId: undefined },
  { targetBotId: '' },
  { targetBotId: 'x'.repeat(129) },
  { authorBotId: null },
  { authorBotId: undefined },
  { authorBotId: '' },
  { authorBotId: 'x'.repeat(129) },
  { turnId: undefined },
  { turnId: null },
  { turnId: '' },
  { workspaceId: 'other' },
  { roomId: 'other' },
  { seq: 0 },
  { seq: 2 },
  { bodyBase64: 'aGVsbG8' },
  { bodyBase64: '/w==' },
  { bodyBase64: Buffer.alloc(1048577).toString('base64') },
])('rejects malformed negotiated bot history', async (change) => {
  await expect(client([{ ...peer, ...change }]).history(scope)).rejects.toThrow('invalid_frame');
});
it('requires consecutive pages and keeps the one MiB decoded bound', async () => {
  await expect(
    client([{ ...peer, seq: 5 }]).history({ ...scope, after: 4, limit: 1 }),
  ).resolves.toMatchObject([{ seq: 5 }]);
  await expect(client([peer, { ...peer, seq: 3 }]).history(scope)).rejects.toThrow('invalid_frame');
  await expect(
    client([{ ...peer, bodyBase64: Buffer.alloc(1048576, 97).toString('base64') }]).history(scope),
  ).resolves.toMatchObject([{ body: 'a'.repeat(1048576) }]);
});
it('keeps modern run results restricted to ordinary bot replies', async () => {
  const q = { ...scope, runId: 'run' };
  await expect(client({ ...q, message: peer }).getResult(q)).rejects.toThrow('invalid_frame');
  await expect(client({ ...q, message: ordinary }).getResult(q)).resolves.toMatchObject({
    author: 'bot',
    authorBotId: 'a',
    targetBotId: 'a',
    body: 'hello',
  });
  await expect(client({ ...q, message: null }).getResult(q)).resolves.toBeNull();
});
