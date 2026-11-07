import type { HttpRequest } from '@runnets/provider-core';
import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from './host.js';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
it('uses fresh pinned B and A2 deadlines after A1 expires and runs an unrelated root between slices', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  let release!: () => void,
    entered!: () => void,
    held = false,
    shifted = false;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    barrier = new Promise<void>((r) => {
      entered = r;
    });
  const http = {
    async send(request: HttpRequest) {
      if (request.url.endsWith('/api/version') && !held) {
        held = true;
        entered();
        await gate;
      }
      const response = await f.httpClient.send(request);
      if (request.url.endsWith('/chat/completions') && !shifted) {
        shifted = true;
        vi.setSystemTime(Date.now() + 1000);
      }
      return response;
    },
  };
  const host = await startLocalRuntime({
    profile: f.profile,
    providerHttpClient: http,
    roomTaskCapacity: 1,
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
  try {
    const start = await client.roomTaskStart(f.input),
      q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: start.rootId };
    await barrier;
    const saved = db
      .prepare('SELECT payload FROM ocean_chat_turns ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r['payload'])));
    expect(saved).toHaveLength(2);
    expect(saved[0].roomSliceDisposition).toBe('yielded');
    const deadline = Date.parse(saved[0].activation.deadlineAt) + 1;
    expect(deadline).toBeLessThan(Date.parse(saved[1].activation.deadlineAt));
    vi.setSystemTime(deadline);
    const other = await client.roomTaskStart({
      ...f.input,
      requestId: 'other',
      text: 'independent',
      initialBotIds: [f.botIds[1]!],
    });
    release();
    let view = await client.roomTaskGet(q);
    for (let i = 0; view.status !== 'completed' && i < 1000; i++) {
      await delay(5);
      view = await client.roomTaskGet(q);
    }
    expect(view.status).toBe('completed');
    expect(f.requests).toHaveLength(4);
    expect(JSON.parse(f.requests[2]!).model).toBe('qwen3:1.7b');
    expect(JSON.parse(f.requests[3]!).model).toBe('deepseek-flash');
    expect((await client.roomTaskGet({ ...q, rootId: other.rootId })).status).toBe('completed');
    const turns = db
      .prepare('SELECT payload FROM ocean_chat_turns ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r['payload'])));
    expect(turns[3].activation.identity).toEqual(saved[0].activation.identity);
    expect(Date.parse(turns[3].activation.admittedAt)).toBeGreaterThan(
      Date.parse(saved[0].activation.deadlineAt),
    );
    expect(turns[0].id).not.toBe(turns[3].id);
    expect(view.rows.filter((r) => r.type === 'slice')).toHaveLength(3);
  } finally {
    release();
    db.close();
    client.close();
    await host.stop();
    vi.useRealTimers();
    f.dispose();
    vi.unstubAllEnvs();
  }
}, 15000);
