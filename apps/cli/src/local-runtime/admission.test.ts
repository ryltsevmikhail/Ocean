import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, Socket } from 'node:net';
import { connectLocalRuntime, readLocalRuntimeDescriptor } from '@runnets/tools-node';
import { createRuntime } from '../runtime.js';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-admit-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const { groupId, ...request } = rooms(runtime.conversations);
  runtime.close();
  const signals: AbortSignal[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const host = await startLocalRuntime({
    profile,
    provider: gatedProvider(
      () => gate,
      (signal) => signals.push(signal),
    ),
  });
  cleanups.push(async () => {
    finish();
    await host.stop();
  });
  const client = async () => {
    const c = await connectLocalRuntime({ profile });
    cleanups.push(() => c.close());
    return c;
  };
  return { request, groupId, client, finish, signals, profile, host };
}

it('authenticates scoped admission, detaches while running, and only dispatches a concurrent fresh request once', async () => {
  const f = await fixture();
  const a = await f.client(),
    b = await f.client();
  expect(a.identity.capabilities).toContain('turns.submit');
  const [first, duplicate] = await Promise.all([a.submit(f.request), b.submit(f.request)]);
  expect(duplicate).toEqual(first);
  expect(first).toMatchObject({
    requestId: 'submit',
    roomId: f.request.roomId,
    runId: expect.any(String),
    turnId: expect.any(String),
    messageId: expect.any(String),
  });
  a.close();
  await vi.waitFor(() => expect(f.signals).toHaveLength(1));
  expect(f.signals[0]!.aborted).toBe(false);
  const { workspaceId, roomId, requestId } = f.request;
  expect(await b.getReceipt({ workspaceId, roomId, requestId })).toEqual(first);
  await expect(b.submit({ ...f.request, requestId: 'overlap' })).rejects.toThrow('room_busy');
  for (const field of ['text', 'roomId', 'workspaceId', 'to', 'taskId'])
    await expect(b.submit({ ...f.request, [field]: 'other' })).rejects.toThrow('request_conflict');
  const scope = {
    workspaceId: f.request.workspaceId,
    roomId: f.request.roomId,
    runId: first.runId!,
  };
  expect(await b.getRun(scope)).toMatchObject({ turnStatus: 'dispatching', taskStatus: 'running' });
  const wrong = { ...scope, roomId: f.groupId };
  expect(await b.getRun(wrong)).toBeNull();
  expect(await b.getReceipt({ workspaceId, roomId: f.groupId, requestId })).toBeNull();
  const recorded = await b.submit({ ...f.request, roomId: f.groupId, requestId: 'group-post' });
  expect(recorded).toMatchObject({ runId: null, turnId: null, messageId: expect.any(String) });
  expect(
    await b.getReceipt({
      workspaceId: scope.workspaceId,
      roomId: f.groupId,
      requestId: 'group-post',
    }),
  ).toEqual(recorded);
  await expect(
    b.submit({ ...f.request, requestId: 'authority', owner: true } as typeof f.request),
  ).rejects.toThrow('invalid_params');
  f.finish();
  await vi.waitFor(async () =>
    expect(await b.getRun(scope)).toMatchObject({
      turnStatus: 'completed',
      taskStatus: 'succeeded',
      resultMessageId: 'reply_' + first.turnId,
    }),
  );
  expect(await b.submit(f.request)).toEqual(first);
  expect(f.signals).toHaveLength(1);
  b.close();
  expect((await f.host.stop()).outcome).toBe('complete');
  await f.host.closed;
  const next = await startLocalRuntime({ profile: f.profile, provider: null });
  try {
    const reopened = await f.client();
    expect(await reopened.submit(f.request)).toEqual(first);
    expect(await reopened.getRun(scope)).toMatchObject({ turnStatus: 'completed' });
  } finally {
    await next.stop();
  }
});

it('recovers either side of a lost acknowledgement through the same original receipt', async () => {
  const f = await fixture(),
    d = readLocalRuntimeDescriptor(f.profile);
  const reader = await f.client();
  expect(reader.identity.capabilities).toContain('receipts.get');
  const { workspaceId, roomId, requestId } = f.request;
  const scope = { workspaceId, roomId, requestId };
  const partial = connect(d.endpoint);
  const closed = new Promise<void>((r) => partial.once('close', r));
  partial.end(
    JSON.stringify({ id: 'hello', method: 'hello', params: d }) +
      '\n' +
      JSON.stringify({ id: 'first', method: 'turns.submit', params: f.request }),
  );
  partial.resume();
  await closed;
  expect(await reader.getReceipt(scope)).toBeNull();
  const original = Socket.prototype.write;
  const drop = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof original>
  ) {
    const frame = args[0];
    if (Buffer.isBuffer(frame) && JSON.parse(frame.toString()).result?.requestId === 'submit') {
      this.destroy();
      return false;
    }
    return Reflect.apply(original, this, args) as boolean;
  });
  const submitter = await f.client();
  try {
    await expect(submitter.submit(f.request)).rejects.toThrow('connection_closed');
  } finally {
    drop.mockRestore();
  }
  const committed = await reader.getReceipt(scope);
  expect(committed?.runId).toEqual(expect.any(String));
  expect(await reader.submit(f.request)).toEqual(committed);
  f.finish();
  await vi.waitFor(async () =>
    expect(await reader.getRun({ workspaceId, roomId, runId: committed!.runId! })).toMatchObject({
      turnStatus: 'completed',
    }),
  );
  expect(f.signals).toHaveLength(1);
});

it('separates the durable receipt from TaskRun creation and copies input before executing', async () => {
  const runtime = createRuntime({ mode: 'ephemeral' });
  const { groupId: _, ...request } = rooms(runtime.conversations);
  const seen: AbortSignal[] = [];
  const input = {
    ...request,
    provider: gatedProvider(
      async () => {},
      (s) => seen.push(s),
    ),
    signal: new AbortController().signal,
    emit: () => {},
  };
  expect(typeof runtime.chat.submit).toBe('function');
  const result = runtime.chat.submit(input);
  if (!result.ok) throw Error('admission failed');
  const { receipt, completion } = result.value;
  const snapshot = runtime.chat.getRun({ ...request, runId: receipt.runId! });
  input.provider = gatedProvider(
    async () => {
      throw Error('mutated');
    },
    () => {},
  );
  const duplicate = runtime.chat.submit(input);
  expect(duplicate).toMatchObject({ ok: true, value: { receipt, completion: null } });
  expect(await snapshot).toMatchObject({
    taskStatus: 'admitted_before_run',
    version: 0,
    turnStatus: 'accepted',
  });
  expect(await completion).toMatchObject({ status: 'completed' });
  expect(seen).toHaveLength(1);
});

it('admits a selected group recipient while another room runs and hides receipts from other workspaces', async () => {
  const f = await fixture(),
    c = await f.client();
  const { workspaceId, roomId, requestId } = f.request;
  const direct = await c.submit(f.request);
  const group = await c.submit({
    ...f.request,
    roomId: f.groupId,
    requestId: 'other-turn',
    to: 'ops',
  });
  expect(group.runId).toEqual(expect.any(String));
  expect(group.runId).not.toBe(direct.runId);
  expect(await c.getReceipt({ workspaceId: 'foreign', roomId, requestId })).toBeNull();
  expect(await c.getRun({ workspaceId: 'foreign', roomId, runId: direct.runId! })).toBeNull();
  expect(await c.getReceipt({ workspaceId, roomId, requestId: 'direct' })).toBeNull();
  f.finish();
  await vi.waitFor(() => expect(f.signals).toHaveLength(2));
});

it('rejects extra fields and payload substitution locally without writing any of the three RPC frames', async () => {
  const f = await fixture(),
    client = await f.client();
  const { workspaceId, roomId, requestId } = f.request;
  const scope = { workspaceId, roomId, requestId };
  const run = { workspaceId, roomId, runId: 'tr_fixture' };
  const writes = vi.spyOn(Socket.prototype, 'write');
  const original = { ...f.request, provider: { apiKey: 'synthetic-credential' } };
  const modified = { ...f.request, toJSON: () => ({ ...f.request, text: 'substituted' }) };
  const extraReceipt = { ...scope, capability: 'synthetic' };
  const modifiedReceipt = { ...scope, toJSON: () => scope };
  const extraRun = { ...run, provider: 'caller-selected' };
  const modifiedRun = { ...run, toJSON: () => run };
  const outcomes = await Promise.allSettled([
    client.submit(original),
    client.submit(modified),
    client.getReceipt(extraReceipt),
    client.getReceipt(modifiedReceipt),
    client.getRun(extraRun),
    client.getRun(modifiedRun),
    client.submit(Object.assign([], f.request)),
    client.getReceipt(Object.assign([], scope)),
    client.getRun(Object.assign([], run)),
  ]);
  const requests = writes.mock.calls.filter(
    ([bytes]) => Buffer.isBuffer(bytes) && bytes.includes(Buffer.from('"method":')),
  );
  writes.mockRestore();
  expect(requests).toHaveLength(0);
  expect(outcomes).toEqual(
    Array.from({ length: 9 }, () => ({ status: 'rejected', reason: Error('invalid_params') })),
  );
  expect(await client.getReceipt(scope)).toBeNull();
  expect(f.signals).toHaveLength(0);
});

it('owns fresh public submissions even if a structurally wider input carries a throwing legacy observer', async () => {
  const runtime = createRuntime({ mode: 'ephemeral' });
  const { groupId: _, ...request } = rooms(runtime.conversations);
  let calls = 0;
  const input = {
    ...request,
    signal: new AbortController().signal,
    emit: () => {},
    provider: gatedProvider(
      async () => {},
      () => {
        calls++;
      },
    ),
    onAdmitted() {
      throw Error('legacy observer');
    },
  };
  const first = runtime.chat.submit(input);
  if (!first.ok) throw Error('admission failed');
  const retry = runtime.chat.submit(input);
  expect(retry).toMatchObject({
    ok: true,
    value: { receipt: first.value.receipt, completion: null },
  });
  expect(await first.value.completion).toMatchObject({ status: 'completed' });
  expect(calls).toBe(1);
  let observed: string | undefined;
  const next = await runtime.chat.send({
    ...input,
    requestId: 'next',
    onAdmitted(turn) {
      expect(calls).toBe(1);
      expect(runtime.chat.getReceipt({ ...request, requestId: 'next' })).toMatchObject({
        turnId: turn.id,
      });
      observed = turn.id;
    },
  });
  expect(observed).toEqual(expect.any(String));
  expect(next).toMatchObject({ ok: true, value: { status: 'completed', id: observed } });
  expect(calls).toBe(2);
});
