import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeOwnerDecisions } from '@runnets/application';
import type { CodingTaskReservation } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';
import { createRuntime } from '../runtime.js';
import { RuntimeProjectReserve } from './project-reserve.js';

it.each(['deny', 'base', 'catalog', 'scope', 'drain'] as const)(
  'refuses reserve without effects at the %s owner boundary',
  async (mode) => {
    const f = await reserveFixture();
    const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
    await runtime.ready;
    const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
    const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
    try {
      const response = await lane.dispatch({ ...f.input });
      if (!('result' in response)) throw Error(JSON.stringify(response));
      const card = (response.result as CodingTaskReservation).decision;
      if (mode === 'catalog') writeFileSync(join(f.directory, 'coding-projects.json'), '[]');
      if (mode === 'base') {
        writeFileSync(join(f.project, 'file'), 'changed');
        f.git('add', '.');
        f.git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'changed',
        );
      }
      if (mode === 'scope') changeRoot(f.directory);
      if (mode === 'drain') {
        expect(await lane.drain()).toBe('settled');
        expect(owner.get(card).status).toBe('cancelled');
        expect(await lane.dispatch({ ...f.input })).toEqual({
          error: { code: 'runtime_draining' },
        });
      } else {
        const result = await owner.resolve(
          card,
          card.bindingDigest,
          1,
          mode === 'deny' ? 'deny' : 'allow-once',
        );
        expect(result.status).toBe(mode === 'deny' ? 'denied' : 'invalidated');
        expect(await lane.dispatch({ ...f.input })).toMatchObject({
          result: { status: result.status, task: null },
        });
      }
      expect(runtime.coding.inspect('ws_ocean', f.input.taskId).ok).toBe(false);
    } finally {
      await lane.drain();
      runtime.close();
      await f.close();
    }
  },
);
it('preserves strict workspace-root equality before offering any owner card', async () => {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  try {
    changeRoot(f.directory);
    expect(await lane.dispatch({ ...f.input })).toEqual({ error: { code: 'coding_denied' } });
    expect(
      owner.store.list({ workspaceId: 'ws_ocean', roomId: f.input.ownerRoomId }, '', 50),
    ).toEqual([]);
  } finally {
    await lane.drain();
    runtime.close();
    await f.close();
  }
});

function changeRoot(directory: string) {
  const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
  try {
    db.prepare('UPDATE ocean_workspace SET root=?').run('/different');
  } finally {
    db.close();
  }
}

it('bounds reserve jobs and shares only the identical in-flight acknowledgement', async () => {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  try {
    const first = lane.dispatch({ ...f.input });
    const duplicate = lane.dispatch({ ...f.input });
    expect(await lane.dispatch({ ...f.input, taskId: 'changed' })).toEqual({
      error: { code: 'request_conflict' },
    });
    const second = lane.dispatch({ ...f.input, requestId: 'second', taskId: 'second' });
    expect(await lane.dispatch({ ...f.input, requestId: 'third', taskId: 'third' })).toEqual({
      error: { code: 'query_limit' },
    });
    expect(await duplicate).toEqual(await first);
    expect(await second).toMatchObject({ result: { status: 'pending' } });
  } finally {
    await lane.drain();
    runtime.close();
    await f.close();
  }
});

it('does not substitute an existing task or service receipt for its durable owner card', async () => {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  try {
    const input = {
      workspaceId: f.input.workspaceId,
      taskId: f.input.taskId,
      requestId: 'cli-start',
      projectRoot: f.project,
      ownerRoomId: f.input.ownerRoomId,
      devBotId: f.input.devBotId,
      reviewRoomId: f.input.reviewRoomId,
      reviewBotId: f.input.reviewBotId,
      devCapabilities: ['project_read', 'propose_write', 'run_test_preset'] as const,
      testPresets: [{ id: 'test', program: '/bin/true', args: [], cwd: '.' as const }],
    };
    expect((await runtime.coding.start(input, { confirm: async () => true })).ok).toBe(true);
    expect(await lane.dispatch({ ...f.input })).toEqual({ error: { code: 'request_conflict' } });
    expect(
      owner.store.list({ workspaceId: 'ws_ocean', roomId: f.input.ownerRoomId }, '', 50),
    ).toEqual([]);
  } finally {
    await lane.drain();
    runtime.close();
    await f.close();
  }
});
