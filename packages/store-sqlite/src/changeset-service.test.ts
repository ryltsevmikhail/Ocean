import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CodingTaskService,
  CodingChangesetService,
  ConversationService,
} from '@runnets/application';
import {
  InMemoryCodingStore,
  InMemoryConversationStore,
  InMemoryProjectLeases,
  InMemoryToolJournal,
} from '@runnets/store';
import { openSqliteStore } from './store.js';
import type { Changeset } from '@runnets/domain';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});
function artifact(taskId: string, text: string): Changeset {
  const payload = {
    taskId,
    baseCommit: 'a'.repeat(40),
    beforeTreeHash: 'b'.repeat(64),
    afterTreeHash: 'c'.repeat(64),
    files: [
      {
        path: 'file.txt',
        before: null,
        after: {
          mode: '100644' as const,
          text,
          sha256: createHash('sha256').update(text).digest('hex'),
        },
      },
    ],
    diff: 'new file\n' + text,
  };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { id: hash, hash, ...payload };
}
async function setup(kind: 'memory' | 'sqlite') {
  const sql = kind === 'sqlite' ? openSqliteStore({ path: ':memory:' }) : undefined;
  if (sql) cleanups.push(() => sql.close());
  const conversation = sql?.conversations ?? new InMemoryConversationStore(),
    store = sql?.coding ?? new InMemoryCodingStore(conversation);
  const clock = { now: () => new Date() },
    leases = new InMemoryProjectLeases(),
    journal = sql?.tools ?? new InMemoryToolJournal();
  let id = 0;
  const c = new ConversationService({ store: conversation, clock, nextId: () => String(++id) });
  const exec = (x: Record<string, unknown>) => {
    const r = c.execute({ workspaceId: 'ws', requestId: String(++id), ...x } as Parameters<
      typeof c.execute
    >[0]);
    if (!r.ok) throw Error('fixture');
    return r.value.data.id;
  };
  exec({ type: 'BindWorkspace', root: '/project' });
  const dev = exec({
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const review = exec({
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const room = exec({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, review] });
  const deps = {
    store,
    clock,
    leases,
    journal,
    ownerId: 'profile',
    projects: {
      inspect: async () => ({ root: '/project', baseCommit: 'a'.repeat(40), clean: true }),
    },
  };
  const coding = new CodingTaskService(deps);
  expect(
    (
      await coding.start(
        {
          taskId: 'task',
          requestId: 'start',
          workspaceId: 'ws',
          projectRoot: '/project',
          ownerRoomId: room,
          reviewRoomId: room,
          devBotId: dev,
          reviewBotId: review,
          devCapabilities: ['project_read'],
          testPresets: [],
        },
        { confirm: async () => true },
      )
    ).ok,
  ).toBe(true);
  let creates = 0,
    captures = 0,
    content = 'first',
    fail = false;
  const plan = {
    root: '/worktrees/task',
    branch: 'codex/ocean/task',
    gitCommonDir: '/project/.git',
  };
  const port = {
    plan: async () => plan,
    preflight: async () => {},
    verify: async () => {},
    create: async () => {
      creates++;
      if (fail) throw Error('interrupted');
      return { ...plan, taskId: 'task', projectRoot: '/project', baseCommit: 'a'.repeat(40) };
    },
  };
  const snapshots = {
    capture: async () => {
      captures++;
      return artifact('task', content);
    },
  };
  const service = new CodingChangesetService({ ...deps, worktrees: port, snapshots });
  const access = {
    taskId: 'task',
    workspaceId: 'ws',
    roomId: room,
    botId: dev,
    policyVersion: 1,
    capability: 'project_read' as const,
  };
  return {
    service,
    coding,
    access,
    review,
    store,
    journal,
    leases,
    deps,
    port,
    snapshots,
    setContent: (text: string) => {
      content = text;
    },
    setFail: () => {
      fail = true;
    },
    counts: () => ({ creates, captures }),
  };
}
for (const kind of ['memory', 'sqlite'] as const) {
  it(
    kind +
      ' persists one worktree and immutable complete changesets with scoped idempotent receipts',
    async () => {
      const s = await setup(kind);
      expect((await s.service.prepare(s.access, { confirm: async () => false })).ok).toBe(false);
      expect(s.counts().creates).toBe(0);
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(true);
      expect(
        (
          await s.service.prepare(s.access, {
            confirm: async () => {
              throw Error('no repeat');
            },
          })
        ).ok,
      ).toBe(true);
      expect(s.store.atomic((tx) => tx.task('task'))?.worktreeRoot).toBe('/worktrees/task');
      const first = await s.service.capture(s.access, 'capture');
      if (!first.ok) throw Error('snapshot');
      s.setContent('second');
      expect(await s.service.capture(s.access, 'capture')).toEqual(first);
      expect(s.counts()).toEqual({ creates: 1, captures: 1 });
      const next = await s.service.capture(s.access, 'next');
      expect(next.ok && next.value.hash !== first.value.hash).toBe(true);
      const review = { ...s.access, botId: s.review, capability: 'changeset_read' as const };
      expect(s.service.read(review, first.value.hash)).toEqual(first);
      expect(() =>
        s.store.atomic((tx) => tx.putChangeset({ ...first.value, diff: 'tampered' })),
      ).toThrow();
      expect((await s.service.prepare(review, { confirm: async () => true })).ok).toBe(false);
      expect((await s.service.capture(review, 'forbidden')).ok).toBe(false);
      expect(s.service.read({ ...review, roomId: 'foreign' }, first.value.hash).ok).toBe(false);
      await s.journal.claim('unknown', 'shell', { taskRunId: 'tr', attemptId: 'at' }, 'synthetic');
      expect(s.service.read(review, first.value.hash)).toEqual(first);
      expect((await s.service.capture(s.access, 'blocked')).ok).toBe(false);
      expect(await s.service.capture(s.access, 'capture')).toEqual(first);
    },
  );
  it(
    kind +
      ' never repeats unknown worktree effects or releases a bound worktree through stage1 cancel',
    async () => {
      const s = await setup(kind);
      s.setFail();
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(false);
      expect(s.store.atomic((tx) => tx.worktree('task'))?.state).toBe('uncertain');
      expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(false);
      expect(s.counts().creates).toBe(1);
      expect(await s.coding.cancel('ws', 'task', { confirm: async () => true })).toMatchObject({
        ok: false,
        error: { code: 'recovery_required' },
      });
    },
  );
  it(kind + ' serializes concurrent preparation of the same task', async () => {
    const s = await setup(kind);
    const result = await Promise.all([
      s.service.prepare(s.access, { confirm: async () => true }),
      s.service.prepare(s.access, { confirm: async () => true }),
    ]);
    expect(result.filter((r) => r.ok)).toHaveLength(1);
    expect(s.counts().creates).toBe(1);
  });
}

for (const kind of ['memory', 'sqlite'] as const)
  it(kind + ' capture receipt failure rolls back the entire artifact transaction', async () => {
    const s = await setup(kind);
    await s.service.prepare(s.access, { confirm: async () => true });
    const failing = new CodingChangesetService({
      ...s.deps,
      store: {
        projectHeld: (root) => s.store.projectHeld(root),
        atomic: (work) =>
          s.store.atomic((tx) => {
            const value = work(tx);
            if (tx.captureReceipt('bad')) throw Error('receipt failure');
            return value;
          }),
      },
      worktrees: s.port,
      snapshots: s.snapshots,
    });
    await expect(failing.capture(s.access, 'bad')).rejects.toThrow('receipt failure');
    expect(s.store.atomic((tx) => tx.captureReceipt('bad'))).toBeNull();
    expect(s.store.atomic((tx) => tx.changeset(artifact('task', 'first').hash))).toBeNull();
    expect((await s.service.capture(s.access, 'good')).ok).toBe(true);
  });

it('pending cancellation cannot release a task after worktree preparation wins the race', async () => {
  const s = await setup('sqlite');
  let approved: (value: boolean) => void = () => {};
  let reached: () => void = () => {};
  const entered = new Promise<void>((r) => {
    reached = r;
  });
  const pending = s.coding.cancel('ws', 'task', {
    confirm: () =>
      new Promise<boolean>((r) => {
        approved = r;
        reached();
      }),
  });
  await entered;
  expect((await s.service.prepare(s.access, { confirm: async () => true })).ok).toBe(true);
  approved(true);
  expect(await pending).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
  const task = s.store.atomic((tx) => tx.task('task'));
  expect(task?.status).toBe('reserved');
  expect(task && s.leases.owns(task.lease)).toBe(true);
});
