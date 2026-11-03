import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { isLocalTurnRequest, type LocalTurnRequest } from '@runnets/contracts';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { openOceanProfile } from './profile.js';

it('recovers a lost wire receipt for the same group prompt, discovers peer posts, and cancels only the selected admitted performer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-reconnect-')),
    profile = join(root, 'p');
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const { workspaceId, groupId: roomId } = rooms(runtime.conversations);
  runtime.close();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const signals: AbortSignal[] = [];
  const host = await startLocalRuntime({
    profile,
    provider: gatedProvider(
      () => gate,
      (s) => signals.push(s),
    ),
  });
  const scope = { workspaceId, roomId },
    peer = await connectLocalRuntime({ profile });
  const ui = await remoteTerminal(profile, roomId),
    other = await remoteTerminal(profile, roomId);
  const captured: LocalTurnRequest[] = [];
  const original = Socket.prototype.write;
  let dropped = false;
  const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof original>
  ) {
    if (Buffer.isBuffer(args[0]) && args[0].at(0) === 123) {
      const frame = JSON.parse(args[0].toString());
      if (
        frame.method === 'turns.submit' &&
        isLocalTurnRequest(frame.params) &&
        frame.params.text === '@ops please check'
      )
        captured.push(frame.params);
      if (!dropped && frame.result?.turnId && frame.result?.requestId === captured[0]?.requestId) {
        dropped = true;
        this.destroy();
        return false;
      }
    }
    return Reflect.apply(original, this, args) as boolean;
  });
  try {
    for (let i = 0; i < 204; i++)
      await peer.submit({ ...scope, text: 'group post ' + i, requestId: 'post-' + i });
    await vi.waitFor(
      () =>
        expect(other.app.selectedRun()?.stream.filter((line) => line.kind === 'user')).toHaveLength(
          204,
        ),
      { timeout: 4000 },
    );
    expect(other.app.selectedRun()?.taskRunId).toBeNull();
    await ui.send('@ops please check');
    expect(dropped).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]);
    const receipt = await peer.getReceipt({ ...scope, requestId: captured[0]!.requestId });
    expect(receipt?.runId).toBeTruthy();
    await vi.waitFor(
      () =>
        expect(other.app.selectedRun()?.remote).toMatchObject({
          runId: receipt!.runId,
          taskStatus: 'running',
        }),
      { timeout: 4000 },
    );
    await vi.waitFor(() => expect(ui.app.frame().split('\n')[0]).toContain('test / @ops / test'), {
      timeout: 3000,
    });
    expect(signals).toHaveLength(1);
    ui.input.end();
    await ui.app.whenExit();
    await ui.app.idle();
    expect(signals[0]?.aborted).toBe(false);
    other.input.write('\x1b');
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await other.app.idle();
    expect(other.app.selectedRun()?.remote).toMatchObject({
      taskStatus: 'cancelling',
      turnStatus: 'dispatching',
    });
    expect(other.app.frame()).toContain('Cancellation requested');
    release();
    await vi.waitFor(() => expect(other.app.selectedRun()?.remote?.turnStatus).toBe('cancelled'), {
      timeout: 4000,
    });
  } finally {
    spy.mockRestore();
    ui.app.stop();
    other.app.stop();
    await Promise.all([ui.app.idle(), other.app.idle()]);
    release();
    peer.close();
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it('keeps the exact submission after an invalid acknowledgement and blocks a different payload until certainty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-ack-')),
    profile = join(root, 'p');
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  const { workspaceId, groupId: roomId } = rooms(offline.conversations);
  offline.close();
  const host = await startLocalRuntime({ profile, provider: null }),
    peer = await connectLocalRuntime({ profile });
  const ui = await remoteTerminal(profile, roomId);
  const original = Socket.prototype.write;
  let damaged = false;
  const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof original>
  ) {
    const data = args[0];
    if (!damaged && Buffer.isBuffer(data) && data.at(0) === 123) {
      const frame = JSON.parse(data.toString());
      if (frame.result?.messageId && frame.result?.turnId === null) {
        damaged = true;
        frame.result.roomId = 'changed';
        args[0] = Buffer.from(JSON.stringify(frame) + '\n');
      }
    }
    return Reflect.apply(original, this, args) as boolean;
  });
  try {
    await ui.send('group note');
    expect(damaged).toBe(true);
    await ui.send('other note');
    expect((await peer.history({ workspaceId, roomId })).map((m) => m.body)).toEqual([
      'group note',
    ]);
    await ui.send('group note');
    expect(ui.app.ui.status).toContain('recorded');
    expect((await peer.history({ workspaceId, roomId })).map((m) => m.body)).toEqual([
      'group note',
    ]);
  } finally {
    spy.mockRestore();
    ui.app.stop();
    await ui.app.idle();
    peer.close();
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('detaches promptly even while a reconnect handshake has no reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-hello-')),
    profile = join(root, 'p');
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  const { groupId } = rooms(offline.conversations);
  offline.close();
  const host = await startLocalRuntime({ profile, provider: null }),
    ui = await remoteTerminal(profile, groupId);
  const original = Socket.prototype.write;
  let dropped = false,
    waiting = false;
  const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof original>
  ) {
    const data = args[0];
    if (Buffer.isBuffer(data) && data.at(0) === 123) {
      const frame = JSON.parse(data.toString());
      if (!dropped && frame.result?.messageId && frame.result?.turnId === null) {
        dropped = true;
        this.destroy();
        return false;
      }
      if (dropped && frame.result?.capabilities) {
        waiting = true;
        return true;
      }
    }
    return Reflect.apply(original, this, args) as boolean;
  });
  try {
    const sending = ui.send('note');
    await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 2000 });
    ui.input.end();
    await ui.app.whenExit();
    let settled = false;
    void sending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
  } finally {
    spy.mockRestore();
    ui.app.stop();
    await host.stop();
    await host.closed;
    await ui.app.idle();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
