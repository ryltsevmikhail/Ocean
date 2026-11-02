import { expect, it } from 'vitest';
import { createRuntime } from './runtime.js';
it('ephemeral hosts never issue coding authority outside shared durable coordination', async () => {
  const a = createRuntime({ mode: 'ephemeral' }),
    b = createRuntime({ mode: 'ephemeral' });
  const input = {
    taskId: 'task',
    requestId: 'start',
    workspaceId: 'ws',
    projectRoot: '/project',
    ownerRoomId: 'room',
    reviewRoomId: 'room',
    devBotId: 'dev',
    reviewBotId: 'review',
    devCapabilities: ['project_read'] as const,
    testPresets: [],
  };
  try {
    for (const runtime of [a, b]) {
      expect(
        await runtime.coding.start(input, {
          confirm: async () => {
            throw Error('must not prompt');
          },
        }),
      ).toMatchObject({ ok: false, error: { code: 'coding_unavailable' } });
      expect(
        runtime.coding.authorize({
          taskId: 'task',
          workspaceId: 'ws',
          roomId: 'room',
          botId: 'dev',
          policyVersion: 1,
          capability: 'project_read',
        }),
      ).toMatchObject({ ok: false, error: { code: 'coding_unavailable' } });
    }
  } finally {
    a.close();
    b.close();
  }
});
