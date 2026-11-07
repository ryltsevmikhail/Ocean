import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { CodingTaskReservation, CodingTaskPreparation } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';
it.each(['pending', 'uncertain', 'drain'] as const)(
  'never replays %s preparation after restart',
  async (mode) => {
    const f = await reserveFixture();
    try {
      const host = f.launch('project-read-owner.test.ts', 'normal');
      await host.ready;
      const a = f.launch('model-process-client.test.ts', 'sdk');
      await a.ready;
      const reserved = await a.call<CodingTaskReservation>('reserveCodingTask', f.input);
      const vote = (card: NonNullable<CodingTaskPreparation['decision']>) => ({
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
        expectedVersion: card.version,
        bindingDigest: card.bindingDigest,
        choice: 'allow-once',
      });
      await a.call('resolveDecision', vote(reserved.decision));
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
      const pending = await a.call<CodingTaskPreparation>('prepareCodingTask', q);
      const card = pending.decision!;
      const ref = {
        workspaceId: card.workspaceId,
        roomId: card.roomId,
        runId: card.runId,
        decisionId: card.decisionId,
      };
      const preview = JSON.parse(await a.call<string>('decisionPreview', ref)) as {
        authorized: { plan: { root: string } };
      };
      const root = preview.authorized.plan.root;
      if (mode === 'uncertain') {
        // An actual conflicting filesystem entry fails creation after durable write intent.
        mkdirSync(root, { recursive: true, mode: 0o700 });
        await a.call('resolveDecision', vote(card));
        await expect
          .poll(() => a.call('prepareCodingTask', q))
          .toMatchObject({ status: 'unconfirmed', worktree: null });
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
        expect(db.prepare('SELECT state FROM ocean_worktrees').all()).toEqual([
          { state: 'uncertain' },
        ]);
        db.close();
        rmSync(root, { recursive: true });
      }
      if (mode === 'drain') await a.call('stop', {});
      await host.kill();
      await a.kill();
      const next = f.launch('project-read-owner.test.ts', 'normal');
      await next.ready;
      const b = f.launch('model-process-client.test.ts', 'sdk');
      await b.ready;
      const result = await b.call('prepareCodingTask', q);
      expect(result).toMatchObject({
        status: mode === 'pending' ? 'interrupted' : mode === 'drain' ? 'cancelled' : 'unconfirmed',
        worktree: null,
        decision: { decisionId: card.decisionId },
      });
      expect(await b.call('prepareCodingTask', q)).toEqual(result);
      expect(existsSync(root)).toBe(false);
      expect(f.git('status', '--porcelain').toString()).toBe('');
      expect(
        f
          .git('worktree', 'list', '--porcelain')
          .toString()
          .match(/^worktree /gm),
      ).toHaveLength(1);
      await b.call('stop', {});
    } finally {
      await f.close();
    }
  },
  20000,
);
it.each(['restore', 'drain'] as const)(
  'refuses prepare on a %s host',
  async (mode) => {
    const f = await reserveFixture();
    try {
      const host = f.launch('project-read-owner.test.ts', mode);
      await host.ready;
      const a = f.launch('model-process-client.test.ts', 'sdk');
      await a.ready;
      if (mode === 'drain') await host.call('start-drain');
      await expect(
        a.call('prepareCodingTask', {
          workspaceId: f.input.workspaceId,
          roomId: f.input.ownerRoomId,
          taskId: f.input.taskId,
          requestId: 'prepare',
          expectedPolicyVersion: 1,
        }),
      ).rejects.toThrow(mode === 'drain' ? 'runtime_draining' : 'client_upgrade_required');
      if (mode === 'drain') await host.call('finish-drain');
    } finally {
      await f.close();
    }
  },
  20000,
);
