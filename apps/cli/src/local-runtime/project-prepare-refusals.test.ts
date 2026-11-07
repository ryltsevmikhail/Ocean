import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeOwnerDecisions } from '@runnets/application';
import type { CodingTaskPreparation } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';
import { createRuntime } from '../runtime.js';
import { RuntimeProjectReserve } from './project-reserve.js';
async function setup() {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const result = await runtime.coding.start(
    {
      ...f.input,
      requestId: 'cli-reserve',
      projectRoot: f.project,
      devCapabilities: ['project_read'],
      testPresets: [],
    },
    { confirm: async () => true },
  );
  if (!result.ok) throw Error(result.error.code);
  const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  const q = {
    workspaceId: f.input.workspaceId,
    roomId: f.input.ownerRoomId,
    taskId: f.input.taskId,
    requestId: 'prepare',
    expectedPolicyVersion: 1,
  };
  return {
    ...f,
    runtime,
    owner,
    lane,
    q,
    access: {
      taskId: q.taskId,
      workspaceId: q.workspaceId,
      roomId: q.roomId,
      botId: f.input.devBotId,
      policyVersion: 1,
      capability: 'project_read' as const,
    },
    async close() {
      await lane.drain();
      runtime.close();
      await f.close();
    },
  };
}
it.each(['deny', 'base', 'scope', 'drain'] as const)(
  'refuses prepare at the %s owner boundary',
  async (mode) => {
    const f = await setup();
    try {
      const response = await f.lane.dispatch(f.q, false, 'prepare');
      if (!('result' in response)) throw Error(JSON.stringify(response));
      const card = (response.result as CodingTaskPreparation).decision!;
      const preview = JSON.parse(f.owner.store.preview(card)!) as {
        authorized: { plan: { root: string } };
      };
      if (mode === 'base') {
        writeFileSync(join(f.project, 'file'), 'new');
        f.git('add', '.');
        f.git(
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'new',
        );
      }
      if (mode === 'scope') {
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
        db.prepare('UPDATE ocean_workspace SET root=?').run('/changed');
        db.close();
      }
      if (mode === 'drain') {
        expect(await f.lane.drain()).toBe('settled');
        expect(f.owner.get(card).status).toBe('cancelled');
        expect(await f.lane.dispatch(f.q, false, 'prepare')).toEqual({
          error: { code: 'runtime_draining' },
        });
      } else {
        expect(
          await f.owner.resolve(
            card,
            card.bindingDigest,
            1,
            mode === 'deny' ? 'deny' : 'allow-once',
          ),
        ).toMatchObject({ status: mode === 'deny' ? 'denied' : 'invalidated' });
      }
      expect(existsSync(preview.authorized.plan.root)).toBe(false);
      expect(
        f
          .git('worktree', 'list', '--porcelain')
          .toString()
          .match(/^worktree /gm),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
it('resolves exact scope before a new card and exposes older CLI preparation as an existing fact', async () => {
  const f = await setup();
  try {
    for (const change of [
      { roomId: f.input.reviewRoomId },
      { workspaceId: 'foreign' },
      { taskId: 'foreign' },
      { expectedPolicyVersion: 2 },
    ]) {
      expect(await f.lane.dispatch({ ...f.q, ...change }, false, 'prepare')).toEqual({
        error: { code: 'coding_denied' },
      });
    }
    expect(
      f.owner.store.list({ workspaceId: f.q.workspaceId, roomId: f.q.roomId }, '', 50),
    ).toEqual([]);
    const result = await f.runtime.codingChanges.prepare(f.access, { confirm: async () => true });
    expect(result.ok).toBe(true);
    expect(await f.lane.dispatch(f.q, false, 'prepare')).toMatchObject({
      result: {
        status: 'existing',
        decision: null,
        worktree: { taskId: f.q.taskId, state: 'ready' },
      },
    });
    expect(
      f.owner.store.list({ workspaceId: f.q.workspaceId, roomId: f.q.roomId }, '', 50),
    ).toEqual([]);
    expect(f.git('status', '--porcelain').toString()).toBe('');
  } finally {
    await f.close();
  }
});

it('shares one bounded job budget across reserve and prepare', async () => {
  const f = await setup();
  try {
    expect(await f.lane.dispatch(f.q, false, 'prepare')).toMatchObject({
      result: { status: 'pending' },
    });
    expect(
      await f.lane.dispatch({ ...f.input, requestId: 'other', taskId: 'other' }),
    ).toMatchObject({ result: { status: 'pending' } });
    expect(await f.lane.dispatch({ ...f.q, requestId: 'third' }, false, 'prepare')).toEqual({
      error: { code: 'query_limit' },
    });
    expect(
      f
        .git('worktree', 'list', '--porcelain')
        .toString()
        .match(/^worktree /gm),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
