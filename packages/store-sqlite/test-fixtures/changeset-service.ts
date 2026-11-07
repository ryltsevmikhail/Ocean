import { afterEach, expect } from 'vitest';
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
import { openSqliteStore } from '@runnets/store-sqlite';
import type { Changeset } from '@runnets/domain';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});
export function artifact(taskId: string, text: string): Changeset {
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
export async function setup(kind: 'memory' | 'sqlite') {
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
