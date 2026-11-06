import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openSqliteStore } from '@runnets/store-sqlite';
import { connectLocalRuntime } from '@runnets/tools-node';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
import { consumerFixture } from '../../../../packages/store-sqlite/test-fixtures/coding-consumer.js';
import { startLocalRuntime } from './host.js';
it('stops an actual held root through the SDK and then shuts down the ordinary host cleanly with zero streams', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture(),
    seed = consumerFixture('ws_ocean');
  const dbPath = join(f.profile, 'runtime.sqlite'),
    store = openSqliteStore({ path: dbPath });
  const taskId = 'held-coding',
    ownerId = createHash('sha256').update(realpathSync(dbPath)).digest('hex');
  try {
    const projectRoot = join(f.root, 'project'),
      worktreeRoot = join(f.root, 'worktree');
    const task = {
      ...seed.b,
      id: taskId,
      projectRoot,
      worktreeRoot,
      ownerRoomId: f.roomId,
      reviewRoomId: f.roomId,
      devBotId: f.botIds[0]!,
      reviewBotId: f.botIds[1]!,
      lease: { ...seed.b.lease, ownerId, taskId, projectRoot, token: 'not-owned-project' },
    };
    const worktree = seed.store.coding.atomic((tx) => tx.worktree(seed.b.id))!;
    store.coding.atomic((tx) => {
      tx.putTask(task);
      tx.putWorktree({
        ...worktree,
        taskId,
        projectRoot,
        root: worktreeRoot,
        gitCommonDir: join(projectRoot, '.git'),
        lease: { ...task.lease, projectRoot: worktreeRoot, token: 'not-owned-worktree' },
      });
    });
  } finally {
    seed.close();
    store.close();
  }
  let qualifications = 0;
  const host = await startLocalRuntime({
    profile: f.profile,
    providerHttpClient: f.httpClient,
    roomTaskCapacity: 1,
    codingTools: {
      sandbox: async () => {
        qualifications++;
        throw Error('must not prepare');
      },
      inspectSandbox: async () => {
        throw Error('must not inspect');
      },
    },
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  try {
    const started = await client.roomTaskStart({
      ...f.input,
      mandate: { ...f.input.mandate, codingTaskId: taskId },
    });
    const q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: started.rootId };
    let view = await client.roomTaskGet(q);
    for (
      let i = 0;
      !view.rows.some((r) => r.type === 'slice' && r.taskStatus === 'created') && i < 200;
      i++
    ) {
      await delay(5);
      view = await client.roomTaskGet(q);
    }
    expect(view.rows.filter((r) => r.type === 'slice')).toMatchObject([
      { turnStatus: 'accepted', taskStatus: 'created' },
    ]);
    expect(
      await client.roomTaskStop({ ...q, requestId: 'stop-held', expectedRevision: view.revision }),
    ).toMatchObject({ status: 'stopped' });
    const stopped = await client.roomTaskGet(q);
    expect(stopped.rows.filter((r) => r.type === 'slice')).toMatchObject([
      { turnStatus: 'cancelled', taskStatus: 'cancelled' },
    ]);
    expect(f.requests).toHaveLength(0);
    expect(qualifications).toBe(0);
    client.close();
    expect(await host.stop()).toMatchObject({ state: 'stopped', outcome: 'complete' });
    await host.closed;
  } finally {
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
it('retains uncertain shutdown for a genuinely unknown dispatched model request', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture();
  let sends = 0;
  const host = await startLocalRuntime({
    profile: f.profile,
    roomTaskCapacity: 1,
    providerHttpClient: {
      async send(request) {
        if (request.url.endsWith('/chat/completions')) {
          sends++;
          throw Error('lost dispatched response');
        }
        return f.httpClient.send(request);
      },
    },
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  try {
    const started = await client.roomTaskStart(f.input),
      q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: started.rootId };
    let view = await client.roomTaskGet(q);
    for (
      let i = 0;
      !view.rows.some((r) => r.type === 'slice' && r.turnStatus === 'uncertain') && i < 200;
      i++
    ) {
      await delay(5);
      view = await client.roomTaskGet(q);
    }
    expect(view.rows.filter((r) => r.type === 'slice')).toMatchObject([
      { turnStatus: 'uncertain' },
    ]);
    expect(
      await client.roomTaskStop({
        ...q,
        requestId: 'stop-unknown',
        expectedRevision: view.revision,
      }),
    ).toMatchObject({ status: 'stopped' });
    expect((await client.roomTaskGet(q)).rows.filter((r) => r.type === 'slice')).toMatchObject([
      { turnStatus: 'uncertain' },
    ]);
    expect(sends).toBe(1);
    client.close();
    expect(await host.stop()).toMatchObject({ state: 'stop_incomplete', outcome: 'uncertain' });
  } finally {
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
