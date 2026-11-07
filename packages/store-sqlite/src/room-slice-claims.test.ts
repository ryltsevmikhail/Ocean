import { taskRunId } from '@runnets/domain';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  recoverChats,
  claimRoomDelivery,
  recoverUnstartedRoomClaims,
  executeChatTurn,
  createChatCommand,
  executeStep,
  TaskRunService,
} from '@runnets/application';
import { roomSlices, answer } from '../test-fixtures/room-slices.js';
import { openSqliteStore } from './index.js';

it('two connections claim once and only the accepted→dispatching winner enters the engine', async () => {
  const f = roomSlices([answer('once')]);
  const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
  const other = openSqliteStore({ path });
  try {
    const start = f.start(),
      id = start.deliveries[0]!.deliveryId;
    const c1 = f.claim(id),
      c2 = claimRoomDelivery({ ...f.deps, store: other.conversations }, id);
    expect(c1.kind).toBe('claimed');
    expect(c2.kind).toBe('existing');
    if (c1.kind !== 'claimed') throw Error('claim');
    const tasks = new TaskRunService({
      log: other.log,
      clock: f.deps.clock,
      ids: { commandId: () => 'unused', eventId: () => 'unused' },
    });
    const input = { ...c1, signal: new AbortController().signal, emit() {} };
    const results = await Promise.allSettled([
      executeChatTurn(f.deps, input, c1),
      executeChatTurn({ ...f.deps, store: other.conversations, tasks }, input, c1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'")
        .get()?.['n'],
    ).toBe(1);
  } finally {
    other.close();
    f.close();
  }
});
it.each(['absent', 'created', 'started', 'model-started'] as const)(
  'discovers only proven unstarted %s claims after a fresh connection',
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), 'room-reopen-'));
    const f = roomSlices([answer('recovered')], ['b'], join(directory, 'store.sqlite'));
    let closed = false;
    let reopened: ReturnType<typeof openSqliteStore> | undefined;
    try {
      const start = f.start(),
        claimed = f.claim(start.deliveries[0]!.deliveryId);
      if (claimed.kind !== 'claimed') throw Error('claim');
      if (phase !== 'absent')
        expect((await f.tasks.execute(createChatCommand(claimed.turn, null))).ok).toBe(true);
      if (phase === 'started' || phase === 'model-started')
        for (const [type, payload] of [
          ['Admit', {}],
          ['Schedule', {}],
          [
            'StartAttempt',
            {
              attemptId: claimed.turn.taskRunId + '_at_0001',
              reason: 'initial',
              provider: 'fixture',
              model: 'one',
            },
          ],
        ] as const) {
          const state = await f.tasks.state(taskRunId(claimed.turn.taskRunId));
          expect(
            (
              await executeStep(
                f.tasks,
                taskRunId(claimed.turn.taskRunId),
                type,
                payload,
                state.version,
              )
            ).ok,
          ).toBe(true);
        }
      if (phase === 'model-started') {
        f.store.conversations.atomic((tx) =>
          tx.putChatTurn({ ...claimed.turn, status: 'dispatching' }),
        );
        const state = await f.tasks.state(taskRunId(claimed.turn.taskRunId));
        expect(
          (
            await executeStep(
              f.tasks,
              taskRunId(claimed.turn.taskRunId),
              'StartModelRequest',
              {
                attemptId: claimed.turn.taskRunId + '_at_0001',
                ordinal: 1,
                activation: claimed.turn.activation!,
                startedAt: f.deps.clock.now().toISOString(),
              },
              state.version,
            )
          ).ok,
        ).toBe(true);
      }
      const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
      f.close();
      closed = true;
      reopened = openSqliteStore({ path });
      reopened.bindRoomHost({ ownerId: 'owner', epochId: null }, { origin: null, active: null });
      const tasks = new TaskRunService({
        log: reopened.log,
        clock: f.deps.clock,
        ids: { commandId: () => 'unused', eventId: () => 'unused' },
      });
      const deps = { ...f.deps, store: reopened.conversations, tasks };
      await recoverChats(deps.store, tasks, deps.clock);
      const eligible = recoverUnstartedRoomClaims(deps);
      expect(eligible).toHaveLength(phase === 'started' || phase === 'model-started' ? 0 : 1);
      expect(f.requests).toHaveLength(0);
      if (eligible[0]) {
        const c = eligible[0];
        const result = await executeChatTurn(
          deps,
          { ...c, signal: new AbortController().signal, emit() {} },
          c,
        );
        expect(result.id).toBe(claimed.turn.id);
        expect(result.text).toBe('recovered');
        expect(
          (await tasks.events(taskRunId(claimed.turn.taskRunId))).filter(
            (e) => e.type === 'task_run.created',
          ),
        ).toHaveLength(1);
      }
    } finally {
      reopened?.close();
      if (!closed) f.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(['receipt', 'checkpoint', 'completed-effect'] as const)(
  'rejects ancillary %s evidence on a truncated created stream',
  async (evidence) => {
    const f = roomSlices([]);
    try {
      const c = f.claim(f.start().deliveries[0]!.deliveryId);
      if (c.kind !== 'claimed') throw Error('claim');
      const id = taskRunId(c.turn.taskRunId);
      expect((await f.tasks.execute(createChatCommand(c.turn, null))).ok).toBe(true);
      if (evidence === 'receipt') {
        f.store.conversations.atomic((tx) => tx.putChatTurn({ ...c.turn, status: 'dispatching' }));
        for (const [type, payload] of [
          ['Admit', {}],
          ['Schedule', {}],
          [
            'StartAttempt',
            {
              attemptId: c.turn.taskRunId + '_at_0001',
              reason: 'initial',
              provider: 'fixture',
              model: 'one',
            },
          ],
          [
            'StartModelRequest',
            {
              attemptId: c.turn.taskRunId + '_at_0001',
              ordinal: 1,
              activation: c.turn.activation!,
              startedAt: f.deps.clock.now().toISOString(),
            },
          ],
        ] as const) {
          expect(
            (await executeStep(f.tasks, id, type, payload, (await f.tasks.state(id)).version)).ok,
          ).toBe(true);
        }
        f.db!.prepare('DELETE FROM events WHERE aggregate_id=? AND sequence>1').run(id);
        f.store.conversations.atomic((tx) => tx.putChatTurn(c.turn));
      } else if (evidence === 'completed-effect') {
        const context = { taskRunId: id, attemptId: id + '_at_0001' };
        f.db!.prepare(
          "INSERT INTO tool_invocations_v2 VALUES('spent','read',?,?,'spent','completed',NULL)",
        ).run(context.taskRunId, context.attemptId);
      } else
        f.db!.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(id, 1, 1, '{"version":5}');
      expect(recoverUnstartedRoomClaims(f.deps)).toEqual([]);
      expect(f.requests).toHaveLength(0);
      expect(f.turns()[0]?.status).toBe('accepted');
    } finally {
      f.close();
    }
  },
);
it('authorizes immutable owner linkage before duplicate disclosure without fresh eligibility', async () => {
  const f = roomSlices([answer('private answer')]);
  try {
    const id = f.start().deliveries[0]!.deliveryId;
    expect(claimRoomDelivery({ ...f.deps, ownerId: 'other-owner' }, id).kind).toBe('held');
    const turn = await f.execute(id);
    expect(claimRoomDelivery({ ...f.deps, ownerId: 'other-owner' }, id)).toEqual({ kind: 'held' });
    f.store.conversations.atomic((tx) => tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1));
    expect(
      claimRoomDelivery(
        {
          ...f.deps,
          clock: {
            now() {
              throw Error('historical replay clock');
            },
          },
          nextId() {
            throw Error('historical replay allocation');
          },
        },
        id,
      ),
    ).toEqual({ kind: 'existing', turn });
  } finally {
    f.close();
  }
});

it.each([false, true])(
  'rechecks selected room grant references at claim, revoked=%s',
  async (revoked) => {
    const { ownerGrant } = await import('../../../test-fixtures/service-authority.js');
    const { roomSlices } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([]);
    try {
      f.store.serviceAuthority.atomic((tx) =>
        tx.putGrant(
          {
            ...ownerGrant,
            subject: {
              ...ownerGrant.subject,
              workspaceId: f.input.workspaceId,
              roomId: 'room',
              botId: 'a',
              projectId: f.deps.sha256('/fixture'),
            },
          },
          null,
        ),
      );
      const start = f.service.startHosted({
        ...f.input,
        initialBotIds: ['a'],
        participants: f.input.participants.map((p) =>
          p.botId === 'a'
            ? { ...p, grantReferences: [{ grantId: ownerGrant.id, revision: 1 }] }
            : p,
        ),
      });
      if (!start.ok) throw Error('grant start');
      if (revoked)
        f.store.serviceAuthority.atomic((tx) =>
          tx.putGrant({ ...tx.grant(ownerGrant.id)!, revision: 2, state: 'revoked' }, 1),
        );
      expect(f.claim(start.value.deliveries[0]!.deliveryId).kind).toBe(
        revoked ? 'held' : 'claimed',
      );
    } finally {
      f.close();
    }
  },
);
