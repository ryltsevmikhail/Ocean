import { expect, it, vi } from 'vitest';
import type { TaskCommand } from '../room-task-protocol.js';
import { createRoomTasks } from './room-task-state.js';
const binding = {
  profileId: 'a'.repeat(64),
  instanceId: '11111111-1111-4111-8111-111111111111',
  supported: true,
};
const summary = {
  rootId: 'root',
  startMessageId: 'msg',
  startSeq: 2,
  status: 'ready',
  revision: 1,
  authority: 'current',
};
const view = {
  workspaceId: 'ws_ocean',
  roomId: 'r',
  rootId: 'root',
  status: 'ready',
  revision: 1,
  fenceReason: null,
  counts: { active: 1, slices: 0, modelStarts: 0, toolCalls: 0 },
  nextPage: null,
  rows: [],
};
const draft = {
  text: 'task',
  participants: [{ botId: 'a', grantReferences: [] }],
  initialBotIds: ['a'],
  mandate: { projectId: null, codingTaskId: null, permissions: [] },
};
function server(extra: (c: TaskCommand | { op: 'service-grants' }) => unknown = () => undefined) {
  return vi.fn(async (c: TaskCommand | { op: 'service-grants' }) => {
    const result = extra(c);
    if (result !== undefined) return result;
    if (c.op === 'task-support') return binding;
    if (c.op === 'task-list')
      return {
        workspaceId: 'ws_ocean',
        roomId: c.input.roomId,
        roots: c.input.roomId === 'r' ? [summary] : [],
        nextBeforeSeq: null,
      };
    if (c.op === 'service-grants') return [];
    if (c.op === 'task-get') return view;
    if (c.op === 'task-observe') return new Promise(() => {});
    throw Error('unexpected');
  });
}
it('ignores held selection and room reads and never starts more than one selected-root waiter', async () => {
  let release!: (v: unknown) => void;
  const request = server((c) =>
    c.op === 'task-get'
      ? new Promise((yes) => {
          release = yes;
        })
      : undefined,
  );
  const s = createRoomTasks(request as never);
  const first = s.context('r');
  await vi.waitFor(() => expect(release).toBeDefined());
  await s.context('other');
  release(view);
  await first;
  expect(s.view.value).toBeNull();
  expect(s.roots.value).toEqual([]);
  expect(request.mock.calls.filter(([c]) => c.op === 'task-start' || c.op === 'task-stop')).toEqual(
    [],
  );
  s.close();
});
it('freezes lost ACK payload and permits only explicit identical replay after fresh same-profile verification', async () => {
  let attempts = 0;
  const receipt = {
    workspaceId: 'ws_ocean',
    roomId: 'r',
    rootId: 'root',
    version: 1,
    messageId: 'msg',
    seq: 1,
    deliveries: [{ botId: 'a', taskId: 'root', deliveryId: 'delivery' }],
  };
  const request = server((c) => {
    if (c.op !== 'task-start') return undefined;
    if (++attempts === 1) throw Error('outcome_unknown');
    if (attempts === 2) throw Error('task_identity_changed');
    return receipt;
  });
  const s = createRoomTasks(request as never);
  await s.context('r');
  await s.start(draft as never);
  expect(s.pending.value).not.toBeNull();
  draft.text = 'edited';
  await s.refresh();
  expect(attempts).toBe(1);
  await s.replay();
  expect(s.pending.value).not.toBeNull();
  await s.refresh();
  await s.replay();
  const calls = request.mock.calls
    .filter(([c]) => c.op === 'task-start')
    .map(([c]) => ('input' in c ? c.input : undefined));
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toEqual(calls[2]);
  expect((calls[0] as { text: string }).text).toBe('task');
  expect(s.receipt.value?.messageId).toBe('msg');
  s.close();
  draft.text = 'task';
});
it('does not dispatch after instance changes and refuses stale root revisions without retrying stop', async () => {
  let identity = binding;
  const request = server((c) => (c.op === 'task-support' ? identity : undefined));
  const s = createRoomTasks(request as never);
  await s.context('r');
  identity = { ...binding, instanceId: crypto.randomUUID() };
  await s.start(draft as never);
  expect(request.mock.calls.filter(([c]) => c.op === 'task-start')).toEqual([]);
  expect(s.stale.value).toBe(true);
  s.close();
});
it('does not turn a held verification into a write in another room, even on a double click', async () => {
  let release!: (v: unknown) => void;
  let hold = false;
  const request = server((c) =>
    c.op === 'task-support' && hold
      ? new Promise((yes) => {
          release = yes;
        })
      : undefined,
  );
  const s = createRoomTasks(request as never);
  await s.context('r');
  hold = true;
  const first = s.start(draft as never),
    second = s.start(draft as never);
  await vi.waitFor(() => expect(release).toBeDefined());
  hold = false;
  await s.context('other');
  release(binding);
  await Promise.all([first, second]);
  expect(request.mock.calls.filter(([c]) => c.op === 'task-start')).toHaveLength(0);
  s.close();
});
it('keeps a held start receipt scoped during a room watermark refresh and never retries a stale stop', async () => {
  let release!: (v: unknown) => void;
  let newer = false;
  const request = server((c) => {
    if (c.op === 'task-start')
      return new Promise((yes) => {
        release = yes;
      });
    if (c.op === 'task-get' && newer) return { ...view, revision: 2 };
    return undefined;
  });
  const s = createRoomTasks(request as never);
  await s.context('r');
  const start = s.start(draft as never);
  await vi.waitFor(() => expect(release).toBeDefined());
  await s.refresh();
  release({
    workspaceId: 'ws_ocean',
    roomId: 'r',
    rootId: 'root',
    version: 1,
    messageId: 'm',
    seq: 1,
    deliveries: [{ botId: 'a', taskId: 'root', deliveryId: 'delivery' }],
  });
  await start;
  expect(s.receipt.value?.messageId).toBe('m');
  expect(s.busy.value).toBe(false);
  newer = true;
  await s.stop();
  expect(request.mock.calls.filter(([c]) => c.op === 'task-stop')).toHaveLength(0);
  expect(s.message.value).toContain('version_conflict');
  s.close();
});
it('keeps a stop acknowledgement distinct from cleanup and never retries an unknown stop on refresh', async () => {
  let stopCount = 0;
  const request = server((c) => {
    if (c.op === 'task-list')
      return {
        workspaceId: 'ws_ocean',
        roomId: 'r',
        roots: [summary, { ...summary, rootId: 'other', startMessageId: 'old', startSeq: 1 }],
        nextBeforeSeq: null,
      };
    if (c.op === 'task-get') return { ...view, rootId: c.input.rootId };
    if (c.op === 'task-stop') {
      ++stopCount;
      throw Error('connection_closed');
    }
    return undefined;
  });
  const s = createRoomTasks(request as never);
  await s.context('r');
  await s.stop();
  expect(s.stopUnknown.value).toBe(true);
  expect(s.stopReceipt.value).toBeNull();
  await s.refresh();
  await s.stop();
  expect(stopCount).toBe(1);
  await s.select('other');
  await s.stop();
  expect(stopCount).toBe(2);
  await s.select('root');
  await s.refresh();
  await s.stop();
  expect(stopCount).toBe(2);
  s.close();
});
it('uses a full assembled read on changed observation, retries only signed-page resync and ignores the previous selected root', async () => {
  const releases = new Map<string, (v: unknown) => void>();
  let resync = true,
    reads = 0;
  const request = server((c) => {
    if (c.op === 'task-list')
      return {
        workspaceId: 'ws_ocean',
        roomId: 'r',
        roots: [summary, { ...summary, rootId: 'second', startSeq: 1, startMessageId: 'older' }],
        nextBeforeSeq: null,
      };
    if (c.op === 'task-get') {
      ++reads;
      if (resync) {
        resync = false;
        throw Error('resync_required');
      }
      return { ...view, rootId: c.input.rootId, revision: reads };
    }
    if (c.op === 'task-observe')
      return new Promise((yes) => {
        releases.set(c.input.rootId, yes);
      });
    return undefined;
  });
  const s = createRoomTasks(request as never);
  await s.context('r');
  expect(reads).toBe(2);
  await s.select('second');
  releases.get('root')!({ kind: 'changed', cursor: 'old', instanceId: binding.instanceId, view });
  await Promise.resolve();
  expect(s.view.value?.rootId).toBe('second');
  await vi.waitFor(() => expect(releases.has('second')).toBe(true));
  releases.get('second')!({
    kind: 'resync',
    cursor: 'new',
    instanceId: binding.instanceId,
    view: { ...view, rootId: 'second' },
  });
  await vi.waitFor(() => expect(reads).toBe(4));
  expect(s.view.value?.revision).toBe(4);
  expect(
    request.mock.calls.filter(([c]) => c.op === 'task-start' || c.op === 'task-stop'),
  ).toHaveLength(0);
  s.close();
});
it('keeps a selected older root visible but read-only when it is outside the refreshed index page', async () => {
  let headOnly = false;
  const request = server((c) => {
    if (c.op === 'task-list')
      return {
        workspaceId: 'ws_ocean',
        roomId: 'r',
        roots: headOnly ? [] : [summary],
        nextBeforeSeq: null,
      };
    return undefined;
  });
  const s = createRoomTasks(request as never);
  await s.context('r');
  headOnly = true;
  await s.refresh();
  expect(s.selected.value).toBe('root');
  expect(s.view.value?.rootId).toBe('root');
  expect(s.current.value).toBe(false);
  await s.stop();
  expect(request.mock.calls.filter(([c]) => c.op === 'task-stop')).toHaveLength(0);
  s.close();
});
it('treats a stop receipt as a fence while preserving unknown child cleanup', async () => {
  const request = server((c) =>
    c.op === 'task-stop'
      ? { ...c.input, revision: c.input.expectedRevision + 1, status: 'stopped' }
      : undefined,
  );
  const s = createRoomTasks(request as never);
  await s.context('r');
  await s.stop();
  expect(s.stopReceipt.value?.status).toBe('stopped');
  expect(s.message.value).toContain('не подтверждает очистку');
  s.close();
  expect(request.mock.calls.filter(([c]) => c.op === 'task-stop')).toHaveLength(1);
});
