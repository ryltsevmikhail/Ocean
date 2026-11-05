import { afterEach, expect, it } from 'vitest';
import {
  CodingTaskService,
  type CodingServiceDeps,
  type StartCodingTask,
} from '@runnets/application';
import { consumerFixture } from '../test-fixtures/coding-consumer.js';
const fixtures: ReturnType<typeof consumerFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function setup() {
  const f = consumerFixture();
  fixtures.push(f);
  f.db.exec("UPDATE ocean_workspace SET root='/new-project'");
  const input: StartCodingTask = {
    taskId: 'new',
    requestId: 'reserve-new',
    workspaceId: 'ws',
    projectRoot: '/requested-alias',
    ownerRoomId: 'room',
    reviewRoomId: 'review-room',
    devBotId: 'dev',
    reviewBotId: 'review',
    devCapabilities: ['project_read'],
    testPresets: [],
  };
  let inspections = 0,
    confirmations = 0,
    acquisitions = 0;
  let inspectHook = async () => {},
    ownerHook = async () => {};
  const deps: CodingServiceDeps = {
    ...f.deps,
    projects: {
      inspect: async () => {
        inspections++;
        await inspectHook();
        return { root: '/new-project', baseCommit: f.task.baseCommit, clean: true };
      },
    },
    leases: {
      ...f.deps.leases,
      acquire: (root, holder) => {
        acquisitions++;
        return f.deps.leases.acquire(root, holder);
      },
    },
  };
  const owner = {
    confirm: async () => {
      confirmations++;
      await ownerHook();
      return true;
    },
  };
  const pending = () =>
    f.db.exec("INSERT INTO tool_invocations_v1 VALUES('late','command','uncertain')");
  return {
    ...f,
    input,
    deps,
    owner,
    pending,
    counts: () => ({ inspections, confirmations, acquisitions }),
    inspectHook: (hook: typeof inspectHook) => {
      inspectHook = hook;
    },
    ownerHook: (hook: typeof ownerHook) => {
      ownerHook = hook;
    },
  };
}
it('inspects an alias read-only, then reserves/replays/cancels a proven disjoint canonical root', async () => {
  const f = setup();
  await f.uncertainA();
  const before = f.rows();
  const service = new CodingTaskService(f.deps);
  const result = await service.start(f.input, f.owner);
  expect(result).toMatchObject({
    ok: true,
    value: { projectRoot: '/new-project', status: 'reserved' },
  });
  expect(f.counts()).toEqual({ inspections: 2, confirmations: 1, acquisitions: 1 });
  expect(await service.start(f.input, f.owner)).toEqual(result);
  expect(f.counts()).toEqual({ inspections: 2, confirmations: 1, acquisitions: 1 });
  expect(await service.cancel('ws', 'new', f.owner)).toMatchObject({
    ok: true,
    value: { status: 'cancelled' },
  });
  expect(f.live.has('new')).toBe(false);
  expect(f.rows()).toEqual(before);
});
it.each(['legacy', 'inspect', 'owner', 'latest', 'canonical-conflict'] as const)(
  'refuses %s conflict before reservation or state publication',
  async (phase) => {
    const f = setup();
    await f.uncertainA();
    if (phase === 'legacy') f.pending();
    if (phase === 'inspect')
      f.inspectHook(async () => {
        f.pending();
      });
    if (phase === 'owner')
      f.ownerHook(async () => {
        f.pending();
      });
    if (phase === 'latest')
      f.inspectHook(async () => {
        if (f.counts().inspections === 2) f.pending();
      });
    const deps =
      phase === 'canonical-conflict'
        ? {
            ...f.deps,
            projects: {
              inspect: async () => ({
                root: '/project',
                baseCommit: f.task.baseCommit,
                clean: true,
              }),
            },
          }
        : f.deps;
    const service = new CodingTaskService(deps);
    expect(await service.start(f.input, f.owner)).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
    expect(f.store.coding.atomic((tx) => tx.task('new'))).toBeNull();
    expect(f.counts().confirmations).toBe(phase === 'owner' || phase === 'latest' ? 1 : 0);
    expect(f.counts().acquisitions).toBe(phase === 'latest' ? 1 : 0);
    if (phase === 'legacy') expect(f.counts().inspections).toBe(0);
    expect(f.live.has('new')).toBe(false);
  },
);
it.each(['owner-conflict', 'lease-loss', 'release-unknown'] as const)(
  'keeps cancellation conservative after %s',
  async (mode) => {
    const f = setup();
    await f.uncertainA();
    const service = new CodingTaskService(f.deps);
    expect((await service.start(f.input, f.owner)).ok).toBe(true);
    if (mode === 'owner-conflict')
      f.ownerHook(async () => {
        f.pending();
      });
    if (mode === 'lease-loss')
      f.ownerHook(async () => {
        f.live.delete('new');
      });
    const current =
      mode === 'release-unknown'
        ? new CodingTaskService({ ...f.deps, leases: { ...f.deps.leases, release: () => false } })
        : service;
    expect(await current.cancel('ws', 'new', f.owner)).toMatchObject({ ok: false });
    expect(f.store.coding.atomic((tx) => tx.task('new'))?.status).toBe(
      mode === 'release-unknown' ? 'cancelled' : 'reserved',
    );
    expect(f.holds().length).toBeGreaterThan(0);
  },
);

it.each([
  'missing-binding',
  'missing-project-root',
  'missing-worktree-root',
  'relative-root',
  'alias-root',
  'unsupported',
  'mixed',
  'unknown',
  'malformed-binding',
  'github',
] as const)('performs zero inspections for an unqualified %s pending footprint', async (mode) => {
  const f = setup();
  const project = {
    kind: 'project-worktree',
    projectId: 'held-project',
    worktreeId: mode === 'missing-project-root' ? null : 'held-worktree',
  };
  const resource = { kind: 'connection', connectionId: 'remote' };
  const github = {
    kind: 'github-repository',
    connectionId: 'remote',
    accountId: 'account',
    repository: 'org/repo',
  };
  const admission = {
    effectKind: 'mutation',
    grantReference: null,
    scope: {
      kind: 'resources',
      resources:
        mode === 'unknown'
          ? [{ kind: 'unknown' }]
          : mode === 'github'
            ? [github]
            : mode === 'unsupported'
              ? [resource]
              : mode === 'mixed'
                ? [project, resource]
                : [project],
    },
    binding:
      mode === 'malformed-binding'
        ? []
        : mode === 'missing-binding'
          ? {}
          : mode === 'missing-project-root'
            ? { worktreeRoot: '/held-worktree' }
            : mode === 'missing-worktree-root'
              ? { projectRoot: '/held-project' }
              : {
                  projectRoot: '/held-project',
                  worktreeRoot:
                    mode === 'relative-root'
                      ? 'relative'
                      : mode === 'alias-root'
                        ? '/held/../else'
                        : '/held-worktree',
                },
  };
  f.db
    .prepare(
      'INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome,admission) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'held',
      'command',
      'held-run',
      'held-attempt',
      'fingerprint',
      'uncertain',
      JSON.stringify(admission),
    );
  const before = f.rows();
  expect(await new CodingTaskService(f.deps).start(f.input, f.owner)).toMatchObject({
    ok: false,
    error: { code: 'recovery_required' },
  });
  expect(f.counts()).toEqual({ inspections: 0, confirmations: 0, acquisitions: 0 });
  expect(f.rows()).toEqual(before);
});
