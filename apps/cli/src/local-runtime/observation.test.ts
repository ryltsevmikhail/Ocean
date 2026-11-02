import { openSqliteStore } from '@runnets/store-sqlite';
import { ConversationService } from '@runnets/application';
import { randomUUID } from 'node:crypto';
import { RuntimeObservers } from './observe.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { connect, Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectLocalRuntime, readLocalRuntimeDescriptor } from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { gatedProvider, rooms } from '../../test-fixtures/local-runtime-admission.test.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-observe-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const { groupId, ...req } = rooms(runtime.conversations);
  runtime.close();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const host = await startLocalRuntime({
    profile,
    provider: gatedProvider(
      () => gate,
      () => {
        calls++;
      },
    ),
  });
  cleanup.push(async () => {
    release();
    await host.stop();
  });
  const client = async () => {
    const c = await connectLocalRuntime({ profile });
    cleanup.push(() => c.close());
    return c;
  };
  const a = await client();
  const receipt = await a.submit(req);
  const scope = { workspaceId: req.workspaceId, roomId: req.roomId },
    run = { ...scope, runId: receipt.runId! };
  const initial = await a.observeRun(run);
  return { run, scope, profile, client, a, initial, release, host, calls: () => calls, groupId };
}
it('caps each peer’s simultaneous waits and frees its slots on detach while the executor completes', async () => {
  const f = await fixture(),
    observer = await f.client();
  const wait = { ...f.run, cursor: f.initial.cursor, waitMs: 30000 };
  const pending = Promise.allSettled(Array.from({ length: 4 }, () => observer.observeRun(wait)));
  await expect(observer.observeRun(wait)).rejects.toThrow('observer_busy');
  observer.close();
  await pending;
  expect(f.calls()).toBe(1);
  const next = f.a.observeRun(wait);
  f.release();
  expect(await next).toMatchObject({ kind: 'changed' });
  await vi.waitFor(async () =>
    expect(await f.a.getResult(f.run)).toMatchObject({ body: 'fixture answer' }),
  );
}, 6000);
it('returns explicit resync across a clean owner restart and resumes durable sequences without another execution', async () => {
  const f = await fixture();
  f.release();
  await vi.waitFor(async () =>
    expect(await f.a.getRun(f.run)).toMatchObject({ turnStatus: 'completed' }),
  );
  const final = await f.a.observeRun(f.run);
  f.a.close();
  expect(await f.host.stop()).toMatchObject({ outcome: 'complete' });
  await f.host.closed;
  const next = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => next.stop());
  const b = await f.client();
  const rebuilt = await b.observeRun({ ...f.run, cursor: final.cursor });
  expect(rebuilt).toMatchObject({ kind: 'resync', roomSeq: 2, snapshot: final.snapshot });
  expect(rebuilt.instanceId).not.toBe(final.instanceId);
  expect(await b.history({ ...f.scope, after: f.initial.roomSeq })).toMatchObject([
    { body: 'fixture answer' },
  ]);
  expect(await b.listEvents({ ...f.run, after: final.snapshot.version })).toEqual([]);
  expect(f.calls()).toBe(1);
});
it('bounds host inputs as well as SDK requests and never serializes invalid caller fields', async () => {
  const f = await fixture(),
    q = f.run;
  const writes = vi.spyOn(Socket.prototype, 'write');
  const outcomes = await Promise.allSettled([
    f.a.history({ ...f.scope, limit: 201 }),
    f.a.listRuns({ ...f.scope, limit: -1 }),
    f.a.listEvents({ ...q, after: 0.5 }),
    f.a.observeRun({ ...q, waitMs: 30001 }),
    f.a.cancelRun({ ...q, expectedVersion: 0, requestId: 'x', toJSON: () => q } as typeof q & {
      expectedVersion: number;
      requestId: string;
    }),
    f.a.listRooms(Object.assign([], f.scope)),
    f.a.getResult({ ...q, extra: 1 } as typeof q),
  ]);
  const wire = writes.mock.calls.filter(
    ([bytes]) => Buffer.isBuffer(bytes) && bytes.includes(Buffer.from('"method":')),
  );
  writes.mockRestore();
  expect(wire).toHaveLength(0);
  expect(
    outcomes.every((r) => r.status === 'rejected' && String(r.reason).includes('invalid_params')),
  ).toBe(true);
  const d = readLocalRuntimeDescriptor(f.profile),
    socket = connect(d.endpoint);
  const chunks: Buffer[] = [];
  socket.on('data', (b: Buffer) => chunks.push(b));
  socket.write(
    [
      ['hello', d],
      ['history.list', { ...f.scope, limit: 201 }],
      ['observe', { ...q, waitMs: 30001 }],
      ['runs.cancel', { ...q, owner: true }],
    ]
      .map(([method, params], i) => JSON.stringify({ id: String(i), method, params }) + '\n')
      .join(''),
  );
  try {
    await vi.waitFor(() =>
      expect(Buffer.concat(chunks).toString().trim().split('\n')).toHaveLength(4),
    );
    const result = Buffer.concat(chunks)
      .toString()
      .trim()
      .split('\n')
      .slice(1)
      .map((s) => JSON.parse(s).error.code);
    expect(result).toEqual(['invalid_params', 'invalid_params', 'invalid_params']);
  } finally {
    socket.destroy();
  }
});
it('bounds history work for an unread pipelined socket and resumes a short byte-limited page without skipping messages', async () => {
  const f = await fixture(),
    room = { workspaceId: f.scope.workspaceId, roomId: f.groupId };
  const body = '\u0001'.repeat(16383) + 'z';
  for (let i = 0; i < 105; i++) await f.a.submit({ ...room, text: body, requestId: 'page-' + i });
  const first = await f.a.history({ ...room, limit: 200 });
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(105);
  const last = await f.a.history({ ...room, limit: 200, after: first.at(-1)!.seq });
  expect([...first, ...last].map((x) => [x.seq, x.body === body])).toEqual(
    Array.from({ length: 105 }, (_, i) => [i + 1, true]),
  );
  const d = readLocalRuntimeDescriptor(f.profile),
    slow = connect(d.endpoint);
  slow.on('error', () => {});
  cleanup.push(() => slow.destroy());
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  try {
    slow.write(
      JSON.stringify({ id: 'h', method: 'hello', params: d }) +
        '\n' +
        Array.from(
          { length: 12 },
          (_, i) =>
            JSON.stringify({
              id: String(i),
              method: 'history.list',
              params: { ...room, limit: 200 },
            }) + '\n',
        ).join(''),
    );
    await vi.waitFor(() =>
      expect(
        sql.mock.calls.filter(([s]) =>
          s.includes('FROM ocean_messages WHERE room_id=? AND workspace_id=? AND seq>?'),
        ).length,
      ).toBeGreaterThan(0),
    );
    f.release();
    await vi.waitFor(async () =>
      expect(await f.a.getResult(f.run)).toMatchObject({ body: 'fixture answer' }),
    );
    // Once a large response backs up, stop querying further coalesced frames on that peer.
    expect(
      sql.mock.calls.filter(([s]) =>
        s.includes('FROM ocean_messages WHERE room_id=? AND workspace_id=? AND seq>?'),
      ).length,
    ).toBeLessThan(5);
  } finally {
    sql.mockRestore();
  }
});
it('observes unaddressed posts in a room with no run, then discovers another client’s new run', async () => {
  const f = await fixture(),
    room = { ...f.scope, roomId: f.groupId },
    writer = await f.client();
  const first = await f.a.observeRoom(room);
  expect(first).toMatchObject({ ...room, kind: 'snapshot', roomSeq: 0 });
  expect(first).not.toHaveProperty('snapshot');
  const changed = f.a.observeRoom({ ...room, cursor: first.cursor, waitMs: 5000 });
  expect(await writer.submit({ ...room, text: 'team note', requestId: 'note' })).toMatchObject({
    runId: null,
  });
  expect(await changed).toMatchObject({ kind: 'changed', roomSeq: 1 });
  expect(await f.a.history({ ...room, after: 0 })).toMatchObject([{ seq: 1, body: 'team note' }]);
  expect(await f.a.listRuns(room)).toEqual([]);
  expect(await f.a.observeRoom({ ...room, cursor: f.initial.cursor })).toMatchObject({
    kind: 'resync',
  });
  const addressed = await writer.submit({
    ...room,
    text: 'question',
    to: 'dev',
    requestId: 'addressed',
  });
  expect(await f.a.listRuns(room)).toMatchObject([{ runId: addressed.runId }]);
  expect(await f.a.observeRun({ ...room, runId: addressed.runId! })).toMatchObject({ roomSeq: 2 });
  f.release();
});
it('resyncs instead of advancing over a missing persisted room sequence', async () => {
  const store = openSqliteStore({ path: ':memory:' });
  try {
    const { groupId, workspaceId } = rooms(
      new ConversationService({
        store: store.conversations,
        clock: { now: () => new Date() },
        nextId: randomUUID,
      }),
    );
    const scope = { workspaceId, roomId: groupId },
      signal = new AbortController().signal;
    const reads = store.openRoomReads(Date.now);
    const obs = new RuntimeObservers(reads, 'fixture');
    const from = await obs.observe(scope, signal);
    store.conversations.atomic((tx) =>
      tx.putMessage({
        ...scope,
        id: 'later',
        seq: 2,
        author: 'user',
        targetBotId: null,
        body: 'later',
        createdAt: 'today',
      }),
    );
    expect(await obs.observe({ ...scope, cursor: from.cursor }, signal)).toMatchObject({
      kind: 'resync',
      roomSeq: 2,
    });
    expect(() => Array.from(reads.history(scope, 1, 1))).toThrow('resync_required');
    obs.close();
  } finally {
    store.close();
  }
});
it('replays a concurrent explicit cancellation receipt after a later cleanup and clean owner restart', async () => {
  const f = await fixture(),
    b = await f.client(),
    cancel = { ...f.run, requestId: 'same', expectedVersion: f.initial.snapshot.version };
  const [first, second] = await Promise.all([f.a.cancelRun(cancel), b.cancelRun(cancel)]);
  expect(first).toEqual(second);
  f.release();
  await vi.waitFor(async () =>
    expect(await b.getRun(f.run)).toMatchObject({
      taskStatus: 'cancelled',
      turnStatus: 'cancelled',
    }),
  );
  expect((await b.getRun(f.run))!.version).toBeGreaterThan(first.version);
  f.a.close();
  b.close();
  await f.host.stop();
  await f.host.closed;
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const next = await f.client();
  expect(await next.cancelRun(cancel)).toEqual(first);
  expect(await next.getResult(f.run)).toBeNull();
  expect(f.calls()).toBe(1);
});
