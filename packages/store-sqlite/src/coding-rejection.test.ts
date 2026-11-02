import { expect, it } from 'vitest';
import {
  CodingTaskService,
  ConversationService,
  type CodingProjectPort,
  type CodingOwnerPort,
} from '@runnets/application';
import {
  InMemoryCodingStore,
  InMemoryConversationStore,
  InMemoryProjectLeases,
  InMemoryToolJournal,
} from '@runnets/store';
function setup() {
  const conversation = new InMemoryConversationStore(),
    store = new InMemoryCodingStore(conversation);
  let id = 0;
  const clock = { now: () => new Date() },
    leases = new InMemoryProjectLeases();
  const c = new ConversationService({ store: conversation, clock, nextId: () => String(++id) });
  const execute = (x: Record<string, unknown>) => {
    const result = c.execute({ workspaceId: 'ws', requestId: String(++id), ...x } as Parameters<
      typeof c.execute
    >[0]);
    if (!result.ok) throw Error('fixture');
    return result.value.data.id;
  };
  execute({ type: 'BindWorkspace', root: '/project' });
  const dev = execute({
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const review = execute({
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  const room = execute({ type: 'CreateGroupRoom', title: 'Team', botIds: [dev, review] });
  const projects: CodingProjectPort = {
    inspect: async () => ({ root: '/project', baseCommit: 'a'.repeat(40), clean: true }),
  };
  const service = new CodingTaskService({
    store,
    leases,
    projects,
    journal: new InMemoryToolJournal(),
    ownerId: 'profile',
    clock,
  });
  const input = {
    taskId: 'task',
    requestId: 'start',
    workspaceId: 'ws',
    projectRoot: '/project',
    ownerRoomId: room,
    reviewRoomId: room,
    devBotId: dev,
    reviewBotId: review,
    devCapabilities: ['project_read'] as const,
    testPresets: [],
  };
  return { service, input, projects, leases };
}
const owner = { confirm: async () => true };
it('rejected reuse of a cancelled task ID never creates an unreachable hold', async () => {
  const s = setup();
  expect((await s.service.start(s.input, owner)).ok).toBe(true);
  expect((await s.service.cancel('ws', 'task', owner)).ok).toBe(true);
  expect(await s.service.start({ ...s.input, requestId: 'different' }, owner)).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  expect(
    s.leases.acquire('/project', {
      ownerId: 'other',
      taskId: 'next',
      requestId: 'next',
      binding: 'next',
      kind: 'coding',
    }).ok,
  ).toBe(true);
});
it('known final project rejection releases its unused hold', async () => {
  const s = setup();
  let calls = 0;
  s.projects.inspect = async () => ({
    root: '/project',
    baseCommit: 'a'.repeat(40),
    clean: ++calls === 1,
  });
  expect(await s.service.start(s.input, owner)).toMatchObject({
    ok: false,
    error: { code: 'project_changed' },
  });
  expect(
    s.leases.acquire('/project', {
      ownerId: 'other',
      taskId: 'next',
      requestId: 'next',
      binding: 'next',
      kind: 'coding',
    }).ok,
  ).toBe(true);
});
it('owner previews distinguish role assignment and include complete room/project revision binding', async () => {
  const s = setup(),
    previews: Parameters<CodingOwnerPort['confirm']>[0][] = [];
  const deny: CodingOwnerPort = {
    confirm: async (p) => {
      previews.push(p);
      return false;
    },
  };
  await s.service.start(s.input, deny);
  await s.service.start(
    { ...s.input, devBotId: s.input.reviewBotId, reviewBotId: s.input.devBotId },
    deny,
  );
  expect(previews).toHaveLength(2);
  expect(previews[0]).toMatchObject({
    workspaceId: 'ws',
    devBotId: s.input.devBotId,
    reviewBotId: s.input.reviewBotId,
    ownerRoomId: s.input.ownerRoomId,
    reviewRoomId: s.input.reviewRoomId,
    baseCommit: 'a'.repeat(40),
  });
  expect(previews[0]?.devBotId).not.toBe(previews[1]?.devBotId);
});
