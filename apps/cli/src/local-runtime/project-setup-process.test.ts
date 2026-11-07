import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { LocalDecision } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';
it('reserves a registered project only after a durable owner decision', async () => {
  const f = await reserveFixture();
  const { directory, project, launch, input } = f;
  const { ownerRoomId, reviewRoomId, devBotId } = input;
  try {
    const owner = launch('project-read-owner.test.ts', 'normal');
    await owner.ready;
    const a = launch('model-process-client.test.ts', 'sdk');
    const b = launch('model-process-client.test.ts', 'sdk');
    await Promise.all([a.ready, b.ready]);
    const call = (p: typeof a, method: string, params: unknown) => p.call(method, params);
    const old = launch('model-process-client.test.ts', 'rc2');
    await old.ready;
    const [pending, duplicate] = await Promise.all([
      a.call<{ status: string; decision: LocalDecision }>('reserveCodingTask', input),
      b.call('reserveCodingTask', input),
    ]);
    expect(duplicate).toEqual(pending);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(await call(b, 'reserveCodingTask', input)).toEqual(pending);
    expect(
      (
        (await call(a, 'listCodingTasks', { workspaceId: 'ws_ocean', projectId: 'next' })) as {
          tasks: unknown[];
        }
      ).tasks,
    ).toEqual([]);
    const card = pending.decision;
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    };
    const vote = {
      ...ref,
      expectedVersion: 1,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
    };
    const preview = JSON.parse(await a.call<string>('decisionPreview', ref));
    expect(preview).toMatchObject({
      operation: 'reserve',
      request: input,
      authorized: {
        projectRoot: project,
        taskId: input.taskId,
        policy: { devCapabilities: ['project_read', 'propose_write', 'run_test_preset'] },
      },
    });
    expect(
      await old.call('raw', {
        method: 'decisions.list',
        params: { workspaceId: 'ws_ocean', roomId: ownerRoomId, limit: 1 },
      }),
    ).toEqual([]);
    for (const method of ['decisions.get', 'decisions.preview', 'decisions.resolve'])
      await expect(
        old.call('raw', {
          method,
          params:
            method === 'decisions.resolve'
              ? vote
              : method === 'decisions.preview'
                ? { ...ref, offset: 0 }
                : ref,
        }),
      ).rejects.toThrow('client_upgrade_required');
    await expect(
      old.call('raw', { method: 'coding.tasks.reserve', params: input }),
    ).rejects.toThrow('client_upgrade_required');
    for (const changed of [
      { taskId: 'other' },
      { ownerRoomId: reviewRoomId },
      { reviewBotId: devBotId },
      { projectId: 'other' },
    ])
      await expect(call(b, 'reserveCodingTask', { ...input, ...changed })).rejects.toThrow(
        /request_conflict|invalid_params/,
      );
    await a.kill(); // The runtime owns the pending job after the submitting peer detaches.
    expect(await call(b, 'resolveDecision', vote)).toMatchObject({ status: 'allowed', version: 2 });
    await expect(call(b, 'resolveDecision', vote)).rejects.toThrow('version_conflict');
    await expect
      .poll(() => call(b, 'reserveCodingTask', input))
      .toMatchObject({ status: 'reserved', task: { id: input.taskId } });
    const reserved = await call(b, 'reserveCodingTask', input);
    expect(JSON.stringify(reserved)).not.toMatch(/lease|token/);
    expect(
      await call(b, 'listCodingTasks', { workspaceId: 'ws_ocean', projectId: 'next' }),
    ).toMatchObject({ tasks: [{ id: input.taskId, worktreeReady: false }] });
    expect(await call(b, 'stop', {})).toMatchObject({ state: 'stopped' });
    await owner.kill();
    writeFileSync(join(directory, 'coding-projects.json'), '[]', { mode: 0o600 });
    const restarted = launch('project-read-owner.test.ts', 'normal');
    await restarted.ready;
    const c = launch('model-process-client.test.ts', 'sdk');
    await c.ready;
    expect(await call(c, 'reserveCodingTask', input)).toEqual(reserved);
    await expect(
      call(c, 'reserveCodingTask', { ...input, ownerRoomId: reviewRoomId }),
    ).rejects.toThrow('request_conflict');
    expect(await call(c, 'stop', {})).toMatchObject({ state: 'stopped' });
  } finally {
    await f.close();
  }
}, 20000);
