import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { codingWorkflowFixture, faultyMath } from '../ocean/coding-workflow-fixture.js';

const workspaceId = 'ws_ocean';
const marker = 'coding.workspace-v1';
const tasksQuery = { workspaceId, projectId: 'alpha' };
type Peer = ReturnType<typeof child>;
const raw = (peer: Peer, method: string, params: unknown) => peer.call('raw', { method, params });

it('pages registered projects and durable owner tasks across two built SDK peers and owner restart', async () => {
  const f = await codingWorkflowFixture('direct');
  const children: Peer[] = [];
  try {
    f.runtime.close();
    const path = join(f.directory, 'runtime.sqlite');
    const store = openSqliteStore({ path });
    try {
      store.coding.atomic((tx) => {
        const task = tx.task('task')!;
        for (const id of ['\ue000', '\u{10000}'])
          tx.putTask({
            ...task,
            id,
            status: 'cancelled',
            worktreeRoot: null,
            lease: { ...task.lease, taskId: id },
          });
      });
    } finally {
      store.close();
    }
    chmodSync(path, 0o600);
    writeFileSync(join(f.worktree, 'math.cjs'), faultyMath);
    const run = join(f.directory, 'r');
    const other = join(f.directory, 'other');
    const mount = join(other, 'unavailable-pnpm');
    mkdirSync(run, { mode: 0o700 });
    mkdirSync(other);
    const env = { ...process.env, XDG_RUNTIME_DIR: run };
    const launch = (file: string, mode: string) => {
      const p = child(file, [f.directory, mode], env);
      children.push(p);
      return p;
    };
    const peer = (mode: string) => launch('model-process-client.test.ts', mode);
    const catalog = join(f.directory, 'coding-projects.json');
    const registry = () =>
      writeFileSync(
        catalog,
        JSON.stringify([
          {
            id: 'zeta',
            root: other,
            testPresets: [],
            mounts: [{ source: mount, target: '/toolchain/pnpm/bin/pnpm' }],
          },
          {
            id: 'alpha',
            root: f.project,
            testPresets: [
              {
                id: 'test',
                program: '/toolchain/private-command',
                args: ['private-argv'],
                cwd: '.',
              },
            ],
            mounts: [],
          },
        ]),
        { mode: 0o600 },
      );
    registry();
    const owner = launch('project-read-owner.test.ts', 'normal');
    const firstIdentity = await owner.ready;
    const a = peer('sdk'),
      b = peer('sdk'),
      old = peer('v1.1');
    const [modern, , legacy] = await Promise.all([
      a.ready as Promise<{ identity: { capabilities: string[] } }>,
      b.ready,
      old.ready as Promise<{ identity: { capabilities: string[] } }>,
    ]);
    expect(modern.identity.capabilities).toHaveLength(81);
    expect(modern.identity.capabilities.filter((c) => c !== marker)).toEqual(
      legacy.identity.capabilities,
    );
    expect(legacy.identity.capabilities).toHaveLength(80);
    expect(await old.call('status')).toMatchObject(legacy.identity);

    const firstPage = {
      workspaceId,
      projects: [{ id: 'alpha', root: f.project, presetIds: ['test'] }],
      nextAfter: 'alpha',
    };
    expect(await a.call('listCodingProjects', { workspaceId, limit: 1 })).toEqual(firstPage);
    expect(await b.call('listCodingProjects', { workspaceId, after: 'alpha', limit: 1 })).toEqual({
      workspaceId,
      projects: [{ id: 'zeta', root: other, presetIds: [] }],
      nextAfter: null,
    });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const snapshot = () =>
        db
          .prepare(
            'SELECT (SELECT count(*) FROM ocean_coding_tasks) AS tasks, (SELECT count(*) FROM ocean_changesets) AS changesets, (SELECT count(*) FROM tool_invocations_v2) AS effects',
          )
          .get();
      const before = snapshot();
      const expected = {
        ...tasksQuery,
        tasks: [
          {
            id: 'task',
            status: 'reserved',
            ownerRoomId: f.room,
            devBotId: expect.any(String),
            reviewRoomId: expect.any(String),
            reviewBotId: expect.any(String),
            worktreeReady: true,
          },
        ],
        nextAfter: 'task',
      };
      const firstTask = { ...tasksQuery, limit: 1 };
      const tasks = await a.call('listCodingTasks', firstTask);
      expect(tasks).toEqual(expected);
      expect(await b.call('listCodingTasks', firstTask)).toEqual(tasks);
      expect(await a.call('listCodingTasks', { ...firstTask, after: 'task' })).toEqual({
        ...tasksQuery,
        tasks: [{ ...expected.tasks[0], id: '\ue000', status: 'cancelled', worktreeReady: false }],
        nextAfter: '\ue000',
      });
      expect(await b.call('listCodingTasks', { ...firstTask, after: '\ue000' })).toEqual({
        ...tasksQuery,
        tasks: [
          { ...expected.tasks[0], id: '\u{10000}', status: 'cancelled', worktreeReady: false },
        ],
        nextAfter: null,
      });
      expect(await b.call('listCodingTasks', { ...tasksQuery, projectId: 'zeta' })).toEqual({
        workspaceId,
        projectId: 'zeta',
        tasks: [],
        nextAfter: null,
      });
      await expect(
        a.call('listCodingTasks', { ...tasksQuery, projectId: 'unregistered' }),
      ).rejects.toThrow('unknown_project');
      await expect(a.call('listCodingProjects', { workspaceId: 'other' })).rejects.toThrow(
        'unknown_workspace',
      );
      await expect(
        b.call('listCodingTasks', { ...tasksQuery, workspaceId: 'other' }),
      ).rejects.toThrow('unknown_workspace');
      await expect(a.call('listCodingProjects', { workspaceId, limit: 51 })).rejects.toThrow(
        'invalid_params',
      );
      await expect(a.call('listCodingTasks', { ...tasksQuery, after: '' })).rejects.toThrow(
        'invalid_params',
      );
      const negotiatedRaw = peer('workspace');
      await negotiatedRaw.ready;
      await expect(
        raw(negotiatedRaw, 'coding.projects.list', { workspaceId, limit: 51 }),
      ).rejects.toThrow('invalid_params');
      await expect(
        raw(negotiatedRaw, 'coding.tasks.list', { ...tasksQuery, projectRoot: f.project }),
      ).rejects.toThrow('invalid_params');

      await expect(raw(old, 'coding.projects.list', { workspaceId })).rejects.toThrow(
        'client_upgrade_required',
      );
      await expect(raw(old, 'coding.tasks.list', tasksQuery)).rejects.toThrow(
        'client_upgrade_required',
      );
      expect(await old.call('listRooms', { workspaceId })).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: f.room })]),
      );
      const codingQuery = { workspaceId, roomId: f.room, id: 'task', offset: 0 };
      const show = await raw(old, 'coding.show', codingQuery);
      expect(show).toMatchObject({ text: expect.stringContaining('"id":"task"') });
      // The existing diff path retains full catalog and sandbox qualification.
      writeFileSync(mount, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      expect(await raw(old, 'coding.diff', codingQuery)).toMatchObject({
        text: expect.stringContaining('math.cjs'),
      });
      rmSync(mount);

      writeFileSync(catalog, '{malformed');
      await expect(b.call('listCodingProjects', { workspaceId })).rejects.toThrow(
        'project_catalog_unavailable',
      );
      await expect(a.call('listCodingTasks', tasksQuery)).rejects.toThrow(
        'project_catalog_unavailable',
      );
      rmSync(catalog);
      symlinkSync(join(f.directory, 'absent-catalog'), catalog);
      await expect(a.call('listCodingProjects', { workspaceId })).rejects.toThrow(
        'project_catalog_unavailable',
      );
      rmSync(catalog);
      expect(await b.call('listCodingProjects', { workspaceId })).toEqual({
        workspaceId,
        projects: [],
        nextAfter: null,
      });
      registry();
      expect(snapshot()).toEqual(before);

      expect(await a.call('stop')).toMatchObject({ state: 'stopped' });
      await owner.kill();
      const restart = launch('project-read-owner.test.ts', 'normal');
      expect(await restart.ready).not.toEqual(firstIdentity);
      const c = peer('sdk'),
        d = peer('sdk');
      await Promise.all([c.ready, d.ready]);
      expect(await c.call('listCodingProjects', { workspaceId, limit: 1 })).toEqual(firstPage);
      expect(await d.call('listCodingTasks', firstTask)).toEqual(tasks);
      expect(snapshot()).toEqual(before);
      expect(await c.call('stop')).toMatchObject({ state: 'stopped' });
    } finally {
      db.close();
    }
  } finally {
    for (const p of children.reverse()) await p.kill();
    f.close();
  }
}, 20000);

it.each(['restore', 'drain'])(
  'refuses project discovery on a %s host',
  async (mode) => {
    const f = await codingWorkflowFixture('direct');
    let owner: Peer | undefined, sdk: Peer | undefined, attempted: Peer | undefined;
    try {
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      const run = join(f.directory, 'r');
      mkdirSync(run, { mode: 0o700 });
      const env = { ...process.env, XDG_RUNTIME_DIR: run };
      owner = child('project-read-owner.test.ts', [f.directory, mode], env);
      await owner.ready;
      sdk = child('model-process-client.test.ts', [f.directory, 'sdk'], env);
      await sdk.ready;
      if (mode === 'drain') {
        expect(await owner.call('start-drain')).toMatchObject({ state: 'draining' });
        await expect(sdk.call('listCodingProjects', { workspaceId })).rejects.toThrow(
          'runtime_draining',
        );
        await expect(sdk.call('listCodingTasks', tasksQuery)).rejects.toThrow('runtime_draining');
        expect(await owner.call('finish-drain')).toMatchObject({ state: 'stop_incomplete' });
        await expect(sdk.call('listCodingProjects', { workspaceId })).rejects.toThrow(
          'runtime_draining',
        );
      } else {
        expect(await sdk.call('status')).toMatchObject({
          capabilities: expect.not.arrayContaining([marker]),
        });
        await expect(sdk.call('listCodingProjects', { workspaceId })).rejects.toThrow(
          'client_upgrade_required',
        );
        await expect(sdk.call('listCodingTasks', tasksQuery)).rejects.toThrow(
          'client_upgrade_required',
        );
        attempted = child('model-process-client.test.ts', [f.directory, 'workspace'], env);
        await attempted.ready;
        await expect(raw(attempted, 'coding.projects.list', { workspaceId })).rejects.toThrow(
          'client_upgrade_required',
        );
        await expect(raw(attempted, 'coding.tasks.list', tasksQuery)).rejects.toThrow(
          'client_upgrade_required',
        );
      }
    } finally {
      await attempted?.kill();
      await sdk?.kill();
      await owner?.kill();
      f.close();
    }
  },
  20000,
);
