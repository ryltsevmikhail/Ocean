import { it, expect } from 'vitest';
import { localProfileClient } from './local-profile-client.js';
import { localPanelClient } from './local-panel-client.js';
import { createHash } from 'node:crypto';
it('refuses an incomplete diff even if the authenticated response binds the task and digest', async () => {
  const q = { workspaceId: 'ws', roomId: 'r', id: 'task' },
    text = JSON.stringify({ workspaceId: 'ws', roomId: 'r', taskId: 'task', diff: 'partial' });
  const c = localPanelClient(async () => ({
    ...q,
    offset: 0,
    version: createHash('sha256').update(text).digest('hex'),
    length: text.length,
    text,
  }));
  await expect(c.codingRead('coding.diff', q)).rejects.toThrow('invalid_frame');
});
it('rejects additional authority flags and mismatched bot metadata', async () => {
  const q = {
    workspaceId: 'ws',
    requestId: 'id',
    handle: 'a',
    name: 'a',
    role: 'a',
    provider: 'p',
    model: 'm',
  };
  const client = localProfileClient(async () => ({
    kind: 'bot',
    data: {
      workspaceId: 'other',
      id: 'bot',
      profileVersion: 1,
      handle: 'a',
      name: 'a',
      role: 'a',
      provider: 'p',
      model: 'm',
    },
  }));
  await expect(client.createBot({ ...q, ...{ owner: true } })).rejects.toThrow('invalid_params');
  await expect(client.createBot(q)).rejects.toThrow('invalid_frame');
  await expect(
    client.openDirect({ workspaceId: 'ws', requestId: 'id', botId: '' }),
  ).rejects.toThrow('invalid_params');
  await expect(
    client.createGroup({ workspaceId: 'ws', requestId: 'id', title: 't', botIds: [] }),
  ).rejects.toThrow('invalid_params');
});
it('requires primitive Git modes in a frozen diff', async () => {
  const q = { workspaceId: 'ws', roomId: 'r', id: 'task' },
    hash = 'a'.repeat(64);
  const text = JSON.stringify({
    workspaceId: q.workspaceId,
    roomId: q.roomId,
    taskId: q.id,
    kind: 'preview',
    hash,
    id: hash,
    beforeTreeHash: hash,
    afterTreeHash: hash,
    baseCommit: hash,
    diff: 'data',
    tests: [],
    files: [{ path: 'f', before: null, after: { text: 'body', sha256: hash, mode: ['100644'] } }],
  });
  const c = localPanelClient(async () => ({
    ...q,
    offset: 0,
    version: createHash('sha256').update(text).digest('hex'),
    length: text.length,
    text,
  }));
  await expect(c.codingRead('coding.diff', q)).rejects.toThrow('invalid_frame');
});
