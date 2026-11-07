import type * as Workspace from './managed-workspace.js';
import { expect, it, vi } from 'vitest';
import type { ManagedWorkspace, ToolEffectAdmission } from '@runnets/domain';
const state = vi.hoisted(() => ({
  opened: [] as string[],
  checked: [] as string[],
  inspected: [] as string[],
  closed: [] as string[],
  expire: false,
  abort: false,
  clock: 100,
  controller: new AbortController(),
  closeFailure: '' as '' | 'async' | 'sync',
  closeWait: Promise.resolve(),
  failure: Error('private sibling close failure'),
  thirdFailure: Error('another private close failure'),
}));
const footprint = (root: string): ManagedWorkspace => ({
  version: 1,
  root,
  boot: '11111111-1111-1111-1111-111111111111',
  mountNamespace: 'mnt:[1]',
  mountId: '1',
  dev: '1',
  ino: '2',
  anchor: null,
});
vi.mock('./managed-workspace.js', async (original) => ({
  ...(await original<typeof Workspace>()),
  openManagedWorkspace: async (root: string) => {
    state.opened.push(root);
    return {
      footprint: footprint(root),
      coordinate: root,
      recheck: async () => {
        state.checked.push(root);
        if (state.expire) state.clock = 200;
        return true;
      },
      inspect: () => {
        state.inspected.push(root);
        if (state.abort) state.controller.abort();
        return true;
      },
      close: () => {
        state.closed.push(root);
        if (root === '/a' && state.closeFailure === 'sync') throw state.failure;
        if (root === '/a' && state.closeFailure === 'async') return Promise.reject(state.failure);
        if (root === '/c' && state.closeFailure) return Promise.reject(state.thirdFailure);
        return root === '/b' ? state.closeWait : Promise.resolve();
      },
    };
  },
}));
import { prepareManagedResourceEvidence } from './managed-resource-evidence.js';
const admission = (root: string): ToolEffectAdmission => ({
  scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: root }] },
  effectKind: 'mutation',
  grantReference: null,
  binding: { connectionId: root, managedWorkspace: { ...footprint(root) } },
});
it.each(['deadline', 'abort'] as const)(
  'uses one shared budget before each final witness inspection: %s',
  async (mode) => {
    Object.assign(state, {
      opened: [],
      checked: [],
      inspected: [],
      closed: [],
      expire: mode === 'deadline',
      abort: mode === 'abort',
      clock: 100,
      controller: new AbortController(),
      closeFailure: '' as '' | 'async' | 'sync',
      closeWait: Promise.resolve(),
      failure: Error('private sibling close failure'),
      thirdFailure: Error('another private close failure'),
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
    const pending = ['/b', '/c'].map((root) => ({
      id: root,
      tool: 'write',
      taskRunId: root,
      attemptId: root,
      fingerprint: root,
      outcome: 'uncertain' as const,
      admission: admission(root),
    }));
    try {
      const preparation = prepareManagedResourceEvidence(
        admission('/a'),
        pending,
        state.controller.signal,
        undefined,
        150,
      );
      if (mode === 'deadline') {
        await expect(preparation).rejects.toThrow('deadline');
        expect(state.checked).toEqual(['/a']);
        expect(state.inspected).toEqual([]);
      } else {
        const proof = await preparation;
        expect(state.checked).toEqual(['/a', '/b', '/c']);
        expect(proof.inspect()).toBe(false);
        expect(state.inspected).toEqual(['/a']);
        await proof.close();
      }
      expect(state.opened).toEqual(['/a', '/b', '/c']);
      expect(state.closed.sort()).toEqual(['/a', '/b', '/c']);
    } finally {
      now.mockRestore();
    }
  },
);

it.each(['async', 'sync'] as const)(
  'attempts every close and joins a held sibling after %s close failure',
  async (failure) => {
    let release!: () => void,
      finished = false;
    Object.assign(state, {
      opened: [],
      checked: [],
      inspected: [],
      closed: [],
      expire: false,
      abort: false,
      clock: 100,
      controller: new AbortController(),
      closeFailure: failure,
      closeWait: new Promise<void>((r) => {
        release = r;
      }),
    });
    const proof = await prepareManagedResourceEvidence(
      admission('/a'),
      ['/b', '/c'].map((root) => ({
        id: root,
        tool: 'write',
        taskRunId: root,
        attemptId: root,
        fingerprint: root,
        outcome: 'uncertain' as const,
        admission: admission(root),
      })),
      state.controller.signal,
    );
    const closing = Promise.resolve()
      .then(() => proof.close())
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        finished = true;
      });
    try {
      await new Promise<void>((r) => setImmediate(r));
      expect(state.closed).toEqual(['/a', '/b', '/c']);
      expect(finished).toBe(false);
    } finally {
      release();
      await closing;
      state.closeFailure = '';
    }
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(state.failure);
    expect((error as AggregateError).errors).toContain(state.thirdFailure);
  },
);

it('keeps preparation failure owned until every attempted close settles and retains both phases errors', async () => {
  let release!: () => void,
    done = false;
  Object.assign(state, {
    opened: [],
    checked: [],
    inspected: [],
    closed: [],
    expire: true,
    abort: false,
    clock: 100,
    controller: new AbortController(),
    closeFailure: 'async',
    closeWait: new Promise<void>((r) => {
      release = r;
    }),
  });
  const now = vi.spyOn(Date, 'now').mockImplementation(() => state.clock);
  const pending = ['/b', '/c'].map((root) => ({
    id: root,
    tool: 'write',
    taskRunId: root,
    attemptId: root,
    fingerprint: root,
    outcome: 'uncertain' as const,
    admission: admission(root),
  }));
  const preparing = prepareManagedResourceEvidence(
    admission('/a'),
    pending,
    state.controller.signal,
    undefined,
    150,
  )
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      done = true;
    });
  try {
    await new Promise<void>((r) => setImmediate(r));
    expect(state.closed).toEqual(['/a', '/b', '/c']);
    expect(done).toBe(false);
  } finally {
    release();
    await preparing;
    now.mockRestore();
    state.closeFailure = '';
  }
  const error = (await preparing) as AggregateError;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error.errors[0] as Error).message).toContain('deadline');
  expect((error.errors[1] as AggregateError).errors).toEqual([state.failure, state.thirdFailure]);
});
