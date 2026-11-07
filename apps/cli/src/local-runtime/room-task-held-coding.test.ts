import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ok } from '@runnets/domain';
import { setup, effects } from '../../test-fixtures/room-coding.js';
import { RuntimeRoomTasks } from './room-tasks.js';
it.each(['lease', 'foreign-effect'] as const)(
  'holds a genuine %s Create-only refusal until a relevant readiness wake',
  async (reason) => {
    const f = setup();
    if (f.claim.kind !== 'claimed') throw Error('claim');
    const originalTurn = f.claim.turn,
      originalResolve = f.resolver.resolve.bind(f.resolver);
    let attempts = 0,
      streams = 0;
    f.resolver.resolve = (bound, at) => {
      const resolved = originalResolve(bound, at);
      if (!resolved.ok) return resolved;
      return ok({
        ...resolved.value,
        provider: {
          ...resolved.value.provider,
          async *stream() {
            streams++;
            yield { type: 'text_delta' as const, text: 'done' };
            yield {
              type: 'usage' as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
            yield {
              type: 'completed' as const,
              stopReason: 'stop' as const,
              rawStopReason: 'stop',
            };
          },
        },
      });
    };
    const ownLease = f.store.coding.atomic((tx) => tx.worktree(f.b.id)!.lease);
    const foreign = { taskRunId: 'other-named-run', attemptId: 'other-attempt' };
    if (reason === 'lease') f.live.delete(ownLease.token);
    else {
      expect(
        await f.store.tools.claim('other-effect', 'coding_write', foreign, 'other', {
          scope: {
            kind: 'resources',
            resources: [
              {
                kind: 'project-worktree',
                projectId: f.deps.projectId(f.b.projectRoot),
                worktreeId: f.b.id,
              },
            ],
          },
          effectKind: 'mutation',
          grantReference: null,
          binding: { taskId: f.b.id },
        }),
      ).toBe(true);
      expect(f.tasks.authorize(f.access())).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
    }
    const second = f.persistence.startHosted({
      workspaceId: 'ws_room',
      roomId: 'room',
      requestId: 'second',
      text: 'other',
      initialBotIds: ['dev'],
      participants: [{ botId: 'dev', grantReferences: [] }],
      mandate: { projectId: null, codingTaskId: null, permissions: [] },
    });
    expect(second.ok).toBe(true);
    const deps = { ...f.persistence.deps, resolver: f.resolver, codingAvailable: true };
    const supervisor = new RuntimeRoomTasks(
      f.persistence,
      deps,
      {
        ...deps,
        tasks: f.runs,
        codingTools: {
          async forTurn(...args) {
            attempts++;
            if (attempts === 10)
              f.db
                .prepare(
                  "UPDATE ocean_room_tasks SET status='paused',revision=revision+1 WHERE id=?",
                )
                .run(
                  f.store.conversations.atomic(
                    (tx) => tx.roomTasks!.task(originalTurn.roomDelivery!.taskId)!.rootId,
                  ),
                );
            return f.factory.forTurn(...args);
          },
        },
      },
      f.store.openRoomReads(Date.now),
      'leases',
      1,
    );
    try {
      supervisor.start();
      for (let i = 0; streams < 1 && i < 200; i++) await delay(5);
      expect(streams).toBe(1);
      expect(attempts).toBe(1);
      expect(effects.qualifications).toBe(0);
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(originalTurn.id))).toEqual(
        originalTurn,
      );
      expect(
        supervisor.dispatch(
          'roomTasks.get',
          {
            workspaceId: originalTurn.workspaceId,
            roomId: originalTurn.roomId,
            rootId: f.store.conversations.atomic(
              (tx) => tx.roomTasks!.task(originalTurn.roomDelivery!.taskId)!.rootId,
            ),
          },
          new AbortController().signal,
          { roomTasks: true, addressedHistory: true, models: true },
        ),
      ).toMatchObject({ result: { status: 'ready' } });
      supervisor.wake();
      await delay(10);
      expect(attempts).toBe(1);
      if (reason === 'lease') f.live.add(ownLease.token);
      else await f.store.tools.settle('other-effect', 'not_started', foreign);
      supervisor.wake(true);
      for (let i = 0; streams < 2 && i < 200; i++) await delay(5);
      expect(attempts).toBe(2);
      expect(streams).toBe(2);
      expect(
        f.store.conversations.atomic((tx) => tx.chatTurn(originalTurn.id)?.activation),
      ).toEqual(originalTurn.activation);
    } finally {
      await supervisor.drain();
      f.close();
    }
  },
);
