import { expect, it } from 'vitest';
import { ChatReviewService } from '@runnets/application';
import { RuntimeDecisions } from './local-runtime/decisions.js';
import { setup, settledRead, effects, script } from '../test-fixtures/room-coding.js';
it.each(['lease', 'foreign', 'altered'] as const)(
  'vetoes a marked read after async preparation on %s evidence',
  async (mode) => {
    const f = setup();
    try {
      const r = await settledRead(f);
      script.beforeRead = async () => {
        await Promise.resolve();
        if (mode === 'lease') f.live.delete('worktree-b');
        else if (mode === 'foreign')
          f.db
            .prepare(
              "INSERT INTO tool_invocations_v2 VALUES('foreign','legacy','foreign','foreign','unknown','uncertain',NULL)",
            )
            .run();
        else
          f.db
            .prepare("UPDATE tool_invocations_v2 SET fingerprint='altered' WHERE task_run_id=?")
            .run(r.context.taskRunId);
      };
      expect(await r.tools.execute(r.call, r.controller.signal, r.context)).toMatchObject({
        isError: true,
      });
      expect(effects.reads).toBe(0);
      expect(
        f.db
          .prepare('SELECT count(*) AS n FROM tool_invocations_v2 WHERE task_run_id=?')
          .get(r.context.taskRunId)?.['n'],
      ).toBe(1);
    } finally {
      f.close();
    }
  },
);
it('requires explicit read consent and refuses every new decision frame to an old peer', async () => {
  const f = setup('confirm');
  let r: Awaited<ReturnType<typeof settledRead>> | undefined;
  try {
    if (f.claim.kind !== 'claimed') throw Error('claim');
    const reviews = new ChatReviewService({
      store: f.store.conversations,
      tasks: f.runs,
      clock: f.deps.clock,
      journal: f.store.tools,
      nextId: () => 'review',
    });
    const decisions = new RuntimeDecisions(f.store.ownerDecisions, reviews, () => 100);
    const controller = new AbortController();
    f.setOwner(decisions.coding(f.claim.turn, controller.signal));
    r = await settledRead(f);
    const read = r.tools.execute(r.call, r.controller.signal, r.context);
    let cards = f.store.ownerDecisions.list({ workspaceId: 'ws_room', roomId: 'room' }, '', 50);
    for (let i = 0; !cards.length && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      cards = f.store.ownerDecisions.list({ workspaceId: 'ws_room', roomId: 'room' }, '', 50);
    }
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.kind).toBe('project-read');
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    };
    for (const [method, params] of [
      ['decisions.list', { workspaceId: card.workspaceId, roomId: card.roomId }],
      ['decisions.get', ref],
      ['decisions.preview', { ...ref, offset: 0 }],
      [
        'decisions.resolve',
        { ...ref, expectedVersion: 1, bindingDigest: card.bindingDigest, choice: 'allow-once' },
      ],
    ] as const)
      expect(await decisions.dispatch(method, params, { models: true })).toEqual({
        error: { code: 'client_upgrade_required' },
      });
    expect(effects.sessions).toBe(0);
    const params = {
      ...ref,
      expectedVersion: 1,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
    };
    const context = { models: true, roomTasks: true, addressedHistory: true };
    const votes = await Promise.all([
      decisions.dispatch('decisions.resolve', params, context),
      decisions.dispatch('decisions.resolve', params, context),
    ]);
    expect(votes.every((v) => 'result' in v)).toBe(true);
    expect(await read).toMatchObject({ isError: false });
    expect(effects.reads).toBe(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(1);
    controller.abort();
  } finally {
    r?.controller.abort();
    f.close();
  }
});
it.each(['missing', 'revoked'] as const)(
  'refuses %s read consent authority before any lazy setup',
  async (mode) => {
    const f = setup('confirm');
    try {
      f.setOwner(
        mode === 'missing'
          ? { decide: async () => 'allow-once' }
          : {
              decide: async () => 'allow-once',
              decideRead: async () => {
                await Promise.resolve();
                f.store.serviceAuthority.atomic((tx) => {
                  const grant = tx.grant('grant-task-b')!;
                  tx.putGrant({ ...grant, revision: 3, state: 'revoked' }, 2);
                });
                return 'allow-once';
              },
            },
      );
      const r = await settledRead(f);
      expect(await r.tools.execute(r.call, r.controller.signal, r.context)).toMatchObject({
        isError: true,
      });
      expect(effects).toEqual({ qualifications: 0, sessions: 0, reads: 0 });
      expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
    } finally {
      f.close();
    }
  },
);
