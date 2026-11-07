import { afterEach, expect, it } from 'vitest';
import { ConversationService, CodingTaskService } from '@runnets/application';
import {
  InMemoryConversationStore,
  InMemoryCodingStore,
  InMemoryProjectLeases,
  InMemoryToolJournal,
} from '@runnets/store';
import { openSqliteStore } from './store.js';
const close: (() => void)[] = [];
afterEach(() => {
  for (const f of close.splice(0)) f();
});
function setup(
  kind: 'memory' | 'sqlite',
  leases = new InMemoryProjectLeases(),
  ownerId = 'profile',
) {
  const sql = kind === 'sqlite' ? openSqliteStore({ path: ':memory:' }) : undefined;
  if (sql) close.push(() => sql.close());
  const conversations = sql?.conversations ?? new InMemoryConversationStore();
  const journal = sql?.tools ?? new InMemoryToolJournal();
  const coding = sql?.coding ?? new InMemoryCodingStore(conversations);
  let id = 0;
  const c = new ConversationService({
    store: conversations,
    clock: { now: () => new Date() },
    nextId: () => String(++id),
  });
  const exec = (x: Record<string, unknown>) =>
    c.execute({ workspaceId: 'ws', requestId: String(++id), ...x } as Parameters<
      typeof c.execute
    >[0]);
  exec({ type: 'BindWorkspace', root: '/project' });
  const dev = exec({
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'Can do anything',
    provider: 'test',
    model: 'test',
  });
  const review = exec({
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'Can edit too',
    provider: 'test',
    model: 'test',
  });
  if (!dev.ok || dev.value.kind !== 'bot' || !review.ok || review.value.kind !== 'bot')
    throw Error('bots');
  const room = exec({
    type: 'CreateGroupRoom',
    title: 'Team',
    botIds: [dev.value.data.id, review.value.data.id],
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('room');
  const service = new CodingTaskService({
    store: coding,
    leases,
    journal,
    ownerId,
    projects: {
      inspect: async () => ({ root: '/project', baseCommit: 'a'.repeat(40), clean: true }),
    },
    clock: { now: () => new Date() },
  });
  const input = {
    taskId: 'task',
    requestId: 'start',
    workspaceId: 'ws',
    projectRoot: '/project',
    ownerRoomId: room.value.data.id,
    reviewRoomId: room.value.data.id,
    devBotId: dev.value.data.id,
    reviewBotId: review.value.data.id,
    devCapabilities: ['project_read', 'propose_write', 'run_test_preset'] as const,
    testPresets: [{ id: 'test', program: 'pnpm', args: ['test'], cwd: '.' as const }],
  };
  return {
    service,
    input,
    journal,
    coding,
    leases,
    exec,
    dev: dev.value.data.id,
    review: review.value.data.id,
  };
}
for (const kind of ['memory', 'sqlite'] as const) {
  it(kind + ' reads only the exact reservation receipt without repeating the effect', async () => {
    const s = setup(kind);
    expect(s.service.reservationReceipt(s.input)).toEqual({ ok: true, value: null });
    expect((await s.service.start(s.input, { confirm: async () => true })).ok).toBe(true);
    expect(s.service.reservationReceipt(s.input)).toMatchObject({
      ok: true,
      value: { id: 'task' },
    });
    expect(s.service.reservationReceipt({ ...s.input, taskId: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
  });
  it(
    kind + ' an old start receipt cannot authorize or appear as a task owned by a new epoch',
    async () => {
      const s = setup(kind);
      expect((await s.service.start(s.input, { confirm: async () => true })).ok).toBe(true);
      const fresh = new CodingTaskService({
        store: s.coding,
        leases: s.leases,
        journal: s.journal,
        ownerId: 'new-epoch',
        clock: { now: () => new Date() },
        projects: {
          inspect: async () => {
            throw Error('old request must not inspect projects');
          },
        },
      });
      expect(
        await fresh.start(s.input, {
          confirm: async () => {
            throw Error('old request must not ask for new authority');
          },
        }),
      ).toMatchObject({ ok: false, error: { code: 'coding_denied' } });
    },
  );
  it(kind + ' scopes immutable task rights; profiles/role prose alone grant nothing', async () => {
    const s = setup(kind);
    const access = {
      taskId: 'task',
      workspaceId: 'ws',
      roomId: s.input.ownerRoomId,
      botId: s.dev,
      policyVersion: 1,
      capability: 'propose_write' as const,
    };
    expect(s.service.authorize(access)).toMatchObject({ ok: false });
    expect(await s.service.start(s.input, { confirm: async () => false })).toMatchObject({
      ok: false,
      error: { code: 'approval_required' },
    });
    expect(await s.service.start(s.input, { confirm: async () => true })).toMatchObject({
      ok: true,
      value: { status: 'reserved', worktreeRoot: null },
    });
    expect(s.service.authorize(access)).toMatchObject({
      ok: true,
      value: { executionEnabled: false },
    });
    for (const change of [
      { botId: s.review },
      { roomId: 'foreign' },
      { taskId: 'other' },
      { workspaceId: 'other' },
      { policyVersion: 2 },
    ])
      expect(s.service.authorize({ ...access, ...change })).toMatchObject({ ok: false });
    expect(
      s.service.authorize({ ...access, botId: s.review, capability: 'changeset_read' }),
    ).toMatchObject({ ok: true });
    const first = await s.service.start(s.input, {
      confirm: async () => {
        throw Error('no repeated consent');
      },
    });
    expect(first.ok).toBe(true);
    expect(
      await s.service.start(
        { ...s.input, devCapabilities: ['project_read'] },
        { confirm: async () => true },
      ),
    ).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
  });
  it(
    kind +
      ' retains project exclusion across rooms/profiles and releases only reserved cancellation',
    async () => {
      const leases = new InMemoryProjectLeases(),
        a = setup(kind, leases, 'one'),
        b = setup(kind, leases, 'two');
      expect((await a.service.start(a.input, { confirm: async () => true })).ok).toBe(true);
      expect(
        await b.service.start({ ...b.input, taskId: 'other' }, { confirm: async () => true }),
      ).toMatchObject({ ok: false, error: { code: 'project_busy' } });
      expect(
        leases.acquire('*', {
          ownerId: 'legacy',
          taskId: 'legacy',
          requestId: 'legacy',
          binding: 'legacy',
          kind: 'legacy-command',
        }).ok,
      ).toBe(false);
      expect((await a.service.cancel('ws', 'task', { confirm: async () => true })).ok).toBe(true);
      expect(
        (await b.service.start({ ...b.input, taskId: 'other' }, { confirm: async () => true })).ok,
      ).toBe(true);
    },
  );
  it(kind + ' global unresolved claims deny start and subsequent authorization', async () => {
    const s = setup(kind);
    await s.journal.claim('effect', 'shell', { taskRunId: 'tr', attemptId: 'at' }, 'synthetic');
    expect(await s.service.start(s.input, { confirm: async () => true })).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
  });
}

for (const kind of ['memory', 'sqlite'] as const) {
  it(
    kind +
      ' personal-room bindings and detached request/preview policy survive owner callback mutation',
    async () => {
      const s = setup(kind);
      const a = s.exec({ type: 'OpenDirectRoom', botId: s.dev }),
        b = s.exec({ type: 'OpenDirectRoom', botId: s.review });
      if (!a.ok || a.value.kind !== 'room' || !b.ok || b.value.kind !== 'room')
        throw Error('rooms');
      const input = {
        ...s.input,
        ownerRoomId: a.value.data.id,
        reviewRoomId: b.value.data.id,
        testPresets: [{ id: 'test', program: 'pnpm', args: ['test'], cwd: '.' as const }],
      };
      const result = await s.service.start(input, {
        confirm: async (preview) => {
          input.testPresets[0]!.args[0] = 'changed';
          (preview.policy.devCapabilities as string[]).push('changeset_read');
          return true;
        },
      });
      expect(result).toMatchObject({
        ok: true,
        value: { policy: { testPresets: [{ args: ['test'] }] } },
      });
      expect(
        s.service.authorize({
          taskId: 'task',
          workspaceId: 'ws',
          roomId: b.value.data.id,
          botId: s.review,
          policyVersion: 1,
          capability: 'propose_write',
        }).ok,
      ).toBe(false);
      await s.journal.claim('after', 'test', { taskRunId: 'tr', attemptId: 'at' }, 'synthetic');
      expect(
        s.service.authorize({
          taskId: 'task',
          workspaceId: 'ws',
          roomId: a.value.data.id,
          botId: s.dev,
          policyVersion: 1,
          capability: 'project_read',
        }),
      ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
      expect(await s.service.cancel('ws', 'task', { confirm: async () => true })).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
    },
  );
  it(
    kind + ' storage failure rolls back task/receipt while retaining its coordination hold',
    async () => {
      const s = setup(kind);
      const failing = new CodingTaskService({
        store: {
          atomic: (work) =>
            s.coding.atomic((tx) => {
              const value = work(tx);
              if (tx.task('task')) throw Error('injected commit failure');
              return value;
            }),
          projectHeld: () => false,
        },
        leases: s.leases,
        journal: s.journal,
        ownerId: 'profile',
        clock: { now: () => new Date() },
        projects: {
          inspect: async () => ({ root: '/project', baseCommit: 'a'.repeat(40), clean: true }),
        },
      });
      await expect(failing.start(s.input, { confirm: async () => true })).rejects.toThrow(
        'injected',
      );
      expect(s.coding.atomic((tx) => tx.task('task'))).toBeNull();
      expect(s.coding.atomic((tx) => tx.receipt('start'))).toBeNull();
    },
  );
}
