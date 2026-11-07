import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
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
    expect(await lane.dispatch({ ...f.input })).toEqual({
      error: { code: 'project_pre_card_coding_denied' },
    });
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
    expect(await lane.dispatch({ ...f.input })).toEqual({
      error: { code: 'project_pre_card_request_conflict' },
    });
    expect(
      owner.store.list({ workspaceId: 'ws_ocean', roomId: f.input.ownerRoomId }, '', 50),
    ).toEqual([]);
    const corrected = await lane.dispatch({ ...f.input, requestId: 'corrected', taskId: 'unused' });
    expect(corrected).toMatchObject({ result: { status: 'pending' } });
    if (!('result' in corrected)) throw Error('corrected reservation did not open');
    const card = (corrected.result as CodingTaskReservation).decision;
    await owner.resolve(card, card.bindingDigest, card.version, 'deny');
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    try {
      db.prepare(
        "INSERT INTO ocean_coding_finalizations VALUES(?,?,?,'uncertain',1,'fixture','{}')",
      ).run('hold', f.input.taskId, f.project);
      const held = { ...f.input, requestId: 'held', taskId: 'held' };
      expect(await lane.dispatch(held)).toEqual({
        error: { code: 'project_pre_card_recovery_required' },
      });
      expect(
        owner.store.list({ workspaceId: 'ws_ocean', roomId: f.input.ownerRoomId }, '', 50),
      ).toHaveLength(1);
      db.prepare("DELETE FROM ocean_coding_finalizations WHERE request_id='hold'").run();
      expect(await lane.dispatch({ ...held, requestId: 'released' })).toMatchObject({
        result: { status: 'pending' },
      });
    } finally {
      db.close();
    }
  } finally {
    await lane.drain();
    runtime.close();
    await f.close();
  }
});

it('reports a catalog read refusal before creating a card and accepts a repaired mount', async () => {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const owner = new RuntimeOwnerDecisions(runtime.ownerDecisions, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  try {
    const source = join(f.directory, 'dependency');
    writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        {
          id: f.input.projectId,
          root: f.project,
          testPresets: [{ id: 'test', program: '/bin/true', args: [], cwd: '.' }],
          mounts: [{ source, target: '/toolchain/pnpm/bin/pnpm' }],
        },
      ]),
    );
    expect(await lane.dispatch(f.input)).toEqual({
      error: { code: 'project_pre_card_catalog_unavailable' },
    });
    expect(
      owner.store.list({ workspaceId: f.input.workspaceId, roomId: f.input.ownerRoomId }, '', 50),
    ).toEqual([]);
    writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    expect(await lane.dispatch({ ...f.input, requestId: 'repaired' })).toMatchObject({
      result: { status: 'pending' },
    });
  } finally {
    await lane.drain();
    runtime.close();
    await f.close();
  }
});

it('keeps unexpected failures unconfirmed around owner card opening', async () => {
  const f = await reserveFixture();
  const runtime = createRuntime({ dbPath: join(f.directory, 'runtime.sqlite') });
  await runtime.ready;
  const store = runtime.ownerDecisions;
  const insert = store.insert.bind(store);
  const injected = vi.spyOn(store, 'insert').mockImplementation((card, preview) => {
    insert(card, preview);
    throw Error('request_conflict');
  });
  const owner = new RuntimeOwnerDecisions(store, Date.now);
  const lane = new RuntimeProjectReserve(f.directory, runtime, owner);
  try {
    const start = vi
      .spyOn(runtime.coding, 'start')
      .mockRejectedValueOnce(Error('recovery_required'));
    try {
      expect(await lane.dispatch({ ...f.input, requestId: 'untyped' })).toEqual({
        error: { code: 'recovery_required' },
      });
      expect(
        owner.store.list({ workspaceId: f.input.workspaceId, roomId: f.input.ownerRoomId }, '', 50),
      ).toEqual([]);
    } finally {
      start.mockRestore();
    }
    expect(await lane.dispatch(f.input)).toEqual({ error: { code: 'request_conflict' } });
    expect(await lane.dispatch(f.input)).toMatchObject({ result: { status: 'pending' } });
    expect(await lane.dispatch({ ...f.input, taskId: 'changed' })).toEqual({
      error: { code: 'request_conflict' },
    });
  } finally {
    expect(await lane.drain()).toBe('uncertain');
    injected.mockRestore();
    runtime.close();
    await f.close();
  }
});
