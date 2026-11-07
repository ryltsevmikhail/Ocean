import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SqliteProjectLeases } from '@runnets/tools-node';
import type { CodingTaskReservation } from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';

it.each(['pending', 'allowed-without-receipt', 'drain'] as const)(
  'does not redispatch %s after detach and restart',
  async (mode) => {
    const f = await reserveFixture();
    const leases = new SqliteProjectLeases();
    try {
      const host = f.launch('project-read-owner.test.ts', 'normal');
      await host.ready;
      const a = f.launch('model-process-client.test.ts', 'sdk');
      await a.ready;
      const pending = await a.call<CodingTaskReservation>('reserveCodingTask', f.input);
      const card = pending.decision;
      if (mode === 'allowed-without-receipt') {
        // Real lease contention after the preview yields allow, but no reservation receipt.
        const held = leases.acquire(f.project, {
          ownerId: 'competitor',
          taskId: 'other',
          requestId: 'other',
          binding: 'other',
          kind: 'coding',
        });
        if (!held.ok) throw Error('fixture_lease');
        try {
          expect(
            await a.call('resolveDecision', {
              workspaceId: card.workspaceId,
              roomId: card.roomId,
              runId: card.runId,
              decisionId: card.decisionId,
              expectedVersion: card.version,
              bindingDigest: card.bindingDigest,
              choice: 'allow-once',
            }),
          ).toMatchObject({ status: 'allowed' });
          await expect
            .poll(() => a.call('reserveCodingTask', f.input))
            .toMatchObject({ status: 'unconfirmed', task: null });
        } finally {
          expect(leases.release(held.value)).toBe(true);
        }
      }
      if (mode === 'drain') expect(await a.call('stop')).toMatchObject({ state: 'stopped' });
      await host.kill();
      await a.kill();
      writeFileSync(join(f.directory, 'coding-projects.json'), '[]');
      const restored = f.launch('project-read-owner.test.ts', 'normal');
      await restored.ready;
      const b = f.launch('model-process-client.test.ts', 'sdk');
      await b.ready;
      const result = await b.call<CodingTaskReservation>('reserveCodingTask', f.input);
      expect(result).toMatchObject({
        status: mode === 'pending' ? 'interrupted' : mode === 'drain' ? 'cancelled' : 'unconfirmed',
        task: null,
        decision: { decisionId: card.decisionId },
      });
      expect(await b.call('reserveCodingTask', f.input)).toEqual(result);
      await expect(
        b.call('reserveCodingTask', { ...f.input, reviewRoomId: f.input.ownerRoomId }),
      ).rejects.toThrow('request_conflict');
      expect(await b.call('stop')).toMatchObject({ state: 'stopped' });
    } finally {
      await f.close();
    }
  },
  20000,
);

it.each(['restore', 'drain'] as const)(
  'refuses reserve on a %s host',
  async (mode) => {
    const f = await reserveFixture();
    try {
      const host = f.launch('project-read-owner.test.ts', mode);
      await host.ready;
      const sdk = f.launch('model-process-client.test.ts', 'sdk');
      await sdk.ready;
      if (mode === 'drain') await host.call('start-drain');
      await expect(sdk.call('reserveCodingTask', f.input)).rejects.toThrow(
        mode === 'drain' ? 'runtime_draining' : 'client_upgrade_required',
      );
      if (mode === 'drain') await host.call('finish-drain');
    } finally {
      await f.close();
    }
  },
  20000,
);
