import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { LocalDecision } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';
it('prepares once after exact owner consent and reads the proven worktree after restart', async () => {
  const f = await reserveFixture();
  try {
    const owner = f.launch('project-read-owner.test.ts', 'normal');
    await owner.ready;
    const a = f.launch('model-process-client.test.ts', 'sdk');
    const b = f.launch('model-process-client.test.ts', 'sdk');
    await Promise.all([a.ready, b.ready]);
    const vote = (card: LocalDecision) => ({
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
      expectedVersion: card.version,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
    });
    const reservation = await a.call<{ decision: LocalDecision }>('reserveCodingTask', f.input);
    await b.call('resolveDecision', vote(reservation.decision));
    await expect
      .poll(() => a.call('reserveCodingTask', f.input))
      .toMatchObject({ status: 'reserved' });
    const q = {
      workspaceId: f.input.workspaceId,
      roomId: f.input.ownerRoomId,
      taskId: f.input.taskId,
      requestId: 'prepare',
      expectedPolicyVersion: 1,
    };
    const [pending, duplicate] = await Promise.all([
      a.call<{ status: string; decision: LocalDecision }>('prepareCodingTask', q),
      b.call('prepareCodingTask', q),
    ]);
    expect(duplicate).toEqual(pending);
    expect(pending.status).toBe('pending');
    const old = f.launch('model-process-client.test.ts', 'rc2');
    await old.ready;
    await expect(old.call('raw', { method: 'coding.tasks.prepare', params: q })).rejects.toThrow(
      'client_upgrade_required',
    );

    const card = pending.decision;
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    };
    const text = await a.call<string>('decisionPreview', ref);
    expect(text).not.toMatch(/lease|token/);
    const preview = JSON.parse(text) as { authorized: { plan: { root: string } } };
    expect(JSON.parse(text)).toMatchObject({
      operation: 'prepare',
      request: q,
      authorized: { task: { id: q.taskId, projectRoot: f.project, policyVersion: 1 } },
    });
    expect(existsSync(preview.authorized.plan.root)).toBe(false);
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT count(*) AS n FROM ocean_worktrees').get()?.['n']).toBe(0);
    db.close();

    for (const changed of [
      { taskId: 'other' },
      { roomId: f.input.reviewRoomId },
      { expectedPolicyVersion: 2 },
    ])
      await expect(b.call('prepareCodingTask', { ...q, ...changed })).rejects.toThrow(
        'request_conflict',
      );
    await a.kill();
    await b.call('resolveDecision', vote(card));
    await expect(b.call('resolveDecision', vote(card))).rejects.toThrow('version_conflict');
    await expect.poll(() => b.call('prepareCodingTask', q)).toMatchObject({ status: 'prepared' });
    const prepared = await b.call('prepareCodingTask', q);
    expect(JSON.stringify(prepared)).not.toMatch(/lease|token/);
    expect(readFileSync(join(f.project, 'file'), 'utf8')).toBe('base');
    expect(f.git('status', '--porcelain').toString()).toBe('');
    expect(
      f
        .git('worktree', 'list', '--porcelain')
        .toString()
        .match(/^worktree /gm),
    ).toHaveLength(2);
    await b.call('stop', {});
    await owner.kill();
    const restarted = f.launch('project-read-owner.test.ts', 'normal');
    await restarted.ready;
    const c = f.launch('model-process-client.test.ts', 'sdk');
    await c.ready;
    expect(await c.call('prepareCodingTask', q)).toEqual(prepared);
    const root = preview.authorized.plan.root;
    renameSync(root, root + '-moved');
    try {
      expect(await c.call('prepareCodingTask', q)).toMatchObject({
        status: 'unconfirmed',
        worktree: null,
      });
      expect(existsSync(root)).toBe(false);
      await expect(c.call('prepareCodingTask', { ...q, requestId: 'new-request' })).rejects.toThrow(
        'recovery_required',
      );
    } finally {
      renameSync(root + '-moved', root);
    }
    expect(await c.call('prepareCodingTask', q)).toEqual(prepared);

    expect(
      f
        .git('worktree', 'list', '--porcelain')
        .toString()
        .match(/^worktree /gm),
    ).toHaveLength(2);
    await c.call('stop', {});
  } finally {
    await f.close();
  }
}, 20000);
