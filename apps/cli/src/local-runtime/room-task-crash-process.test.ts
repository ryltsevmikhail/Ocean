import { expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { RoomTaskStart, RoomTaskReceipt, RoomTaskRootView } from '@runnets/contracts';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { configureService, journal } from '../../test-fixtures/service-confirmation-rig.js';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
it.each(['model', 'service'] as const)(
  'keeps a marked %s effect unknown across SIGKILL and two built owner/client lifetimes without retry',
  async (mode) => {
    const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-room-tasks' },
      owner = child('room-task-process-owner.test.ts', [mode + '-crash'], env);
    const ready = (await owner.ready) as { profile: string; input: RoomTaskStart };
    const toy = mode === 'service' ? await httpFixture('defer-response') : null;
    let successor: ReturnType<typeof child> | undefined;
    let a = child('room-task-process-peer.test.ts', [ready.profile], env),
      b = child('room-task-process-peer.test.ts', [ready.profile], env);
    try {
      await Promise.all([a.ready, b.ready]);
      let input = ready.input;
      if (toy) {
        const connection = await configureService(
          { profile: ready.profile, roomId: input.roomId, botId: input.initialBotIds[0]! },
          toy.url.href,
          'autonomous',
        );
        const permissions = [
          {
            kind: 'service' as const,
            connectionId: 'test',
            trustRevision: connection.trustRevision,
            baselineCatalogId: connection.currentCatalogId!,
            tools: { kind: 'exact' as const, names: ['write'] },
            resources: [{ kind: 'connection' as const, connectionId: 'test' }],
          },
        ];
        input = {
          ...input,
          participants: input.participants.map((p) =>
            p.botId === input.initialBotIds[0]
              ? { ...p, grantReferences: [{ grantId: 'grant', revision: 1 }] }
              : p,
          ),
          mandate: { ...input.mandate, permissions },
        };
      }
      const start = await a.call<RoomTaskReceipt>('start', input),
        scope = { workspaceId: input.workspaceId, roomId: input.roomId, rootId: start.rootId };
      if (toy) {
        await vi.waitFor(() => expect(toy.stats.effects).toBe(1));
        expect(journal(ready.profile)).toMatchObject([{ outcome: 'started' }]);
      } else await owner.call('held');
      const before = await b.call<RoomTaskRootView>('get', scope),
        slice = before.rows.find((r) => r.type === 'slice');
      if (slice?.type !== 'slice') throw Error('slice');
      expect(before.counts.modelStarts).toBe(1);
      expect(await owner.call('requests')).toHaveLength(1);
      await a.kill();
      await b.kill();
      await owner.kill();
      successor = child('room-task-process-recover.test.ts', [ready.profile], env);
      await successor.ready;
      a = child('room-task-process-peer.test.ts', [ready.profile], env);
      b = child('room-task-process-peer.test.ts', [ready.profile], env);
      await Promise.all([a.ready, b.ready]);
      const recovered = await a.call<RoomTaskRootView>('get', scope);
      expect(await b.call('get', scope)).toEqual(recovered);
      expect(recovered.rows.find((r) => r.type === 'slice')).toMatchObject({
        turnId: slice.turnId,
        runId: slice.runId,
        taskStatus: 'reconciling',
        resultMessageId: null,
        hold: 'unknown',
      });
      expect(recovered.counts.modelStarts).toBe(1);
      expect(await a.call('start', input)).toEqual(start);
      await expect(
        a.call('cancel', {
          workspaceId: scope.workspaceId,
          roomId: scope.roomId,
          runId: slice.runId,
          requestId: 'cancel',
          expectedVersion: recovered.rows.find((r) => r.type === 'slice')?.version,
        }),
      ).rejects.toThrow('run_not_active');
      await a.call('stop', { ...scope, requestId: 'stop', expectedRevision: recovered.revision });
      const stopped = await b.call<RoomTaskRootView>('get', scope);
      expect(stopped.status).toBe('stopped');
      expect(stopped.counts.active).toBe(1);
      expect(await successor.call('requests')).toBe(0);
      if (toy) {
        expect([toy.stats.calls, toy.stats.effects]).toEqual([1, 1]);
        expect(journal(ready.profile)).toMatchObject([{ outcome: 'uncertain' }]);
      } else {
        const db = new DatabaseSync(join(ready.profile, 'runtime.sqlite'), { readOnly: true });
        try {
          expect(
            db
              .prepare(
                "SELECT count(*) AS n FROM events WHERE aggregate_id=? AND type IN ('attempt.model_request_settled','task_run.cancelled')",
              )
              .get(slice.runId)?.['n'],
          ).toBe(0);
        } finally {
          db.close();
        }
      }
    } finally {
      await a.kill();
      await b.kill();
      await owner.kill();
      if (successor) {
        await successor.call('close');
        await successor.kill();
      }
      await toy?.close();
      rmSync(dirname(ready.profile), { recursive: true, force: true });
    }
  },
  20000,
);
