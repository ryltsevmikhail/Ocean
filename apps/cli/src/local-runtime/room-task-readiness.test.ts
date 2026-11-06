import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from './host.js';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
it('wakes an existing eligible queued root after an ordinary provider readiness check', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  const f = await roomTaskHostFixture(),
    host = await startLocalRuntime({ profile: f.profile, providerHttpClient: f.httpClient }),
    client = await connectLocalRuntime({ profile: f.profile });
  try {
    const start = await client.roomTaskStart(f.input),
      scope = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: start.rootId };
    await delay(20);
    expect(f.requests).toHaveLength(0);
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
    await client.checkModelConnection({ connectionId: 'legacy:deepseek' });
    let view = await client.roomTaskGet(scope);
    for (let i = 0; view.status !== 'completed' && i < 300; i++) {
      await delay(5);
      view = await client.roomTaskGet(scope);
    }
    expect(view.status).toBe('completed');
    expect(f.requests).toHaveLength(3);
  } finally {
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
