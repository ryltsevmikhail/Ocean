import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { LocalCancelRequest, LocalTurnReceipt } from '@runnets/contracts';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { openOceanProfile } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { open, wait };
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-faults-')),
    profile = join(root, 'p');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const { workspaceId, groupId: roomId } = rooms(runtime.conversations);
  runtime.close();
  const release = gate();
  let calls = 0;
  const start = () =>
    startLocalRuntime({
      profile,
      provider: gatedProvider(
        () => (calls === 1 ? Promise.resolve() : release.wait),
        () => {
          calls++;
        },
      ),
    });
  const host = await start();
  cleanup.push(async () => {
    release.open();
    await host.stop();
    await host.closed;
  });
  const peer = await connectLocalRuntime({ profile });
  cleanup.push(() => peer.close());
  return { profile, scope: { workspaceId, roomId }, host, start, peer };
}

it('an idle terminal reauthenticates and discovers peer history after graceful owner restart', async () => {
  const f = await setup();
  const watching = gate();
  let submissions = 0;
  const ui = await remoteTerminal(f.profile, f.scope.roomId, undefined, (c) => ({
    ...c,
    submit: (q) => {
      submissions++;
      return c.submit(q);
    },
    observeRoom: (q) => {
      if (q.cursor && submissions) watching.open();
      return c.observeRoom(q);
    },
  }));
  cleanup.push(() => ui.app.stop());
  await ui.send('post before restart');
  await watching.wait;
  // Ensure the first owner's bounded wait is outstanding before drain.
  await new Promise<void>((r) => setTimeout(r, 60));
  f.peer.close();
  expect(await f.host.stop()).toMatchObject({ outcome: 'complete' });
  await f.host.closed;
  const second = await f.start();
  cleanup.push(async () => {
    await second.stop();
    await second.closed;
  });
  const peer = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => peer.close());
  await peer.submit({ ...f.scope, text: 'post after restart', requestId: 'peer-note' });
  await vi.waitFor(() => expect(ui.app.frame()).toContain('post after restart'), { timeout: 2500 });
  expect(await peer.listRuns(f.scope)).toHaveLength(0);
  expect((await peer.history(f.scope)).map((m) => m.body)).toEqual([
    'post before restart',
    'post after restart',
  ]);
  expect(submissions).toBe(1);
});

it.each(['message', 'run'])(
  'retains and presents the confirmed %s receipt while only its read fails and retries',
  async (kind) => {
    const f = await setup();
    let fail = false;
    let admitted: LocalTurnReceipt | undefined;
    let submissions = 0;
    const selected = gate(),
      released = gate();
    const ui = await remoteTerminal(f.profile, f.scope.roomId, undefined, (c) => ({
      ...c,
      submit: async (q) => {
        submissions++;
        admitted = await c.submit(q);
        fail = true;
        return admitted;
      },
      history: async (q) => {
        if (fail) {
          selected.open();
          await released.wait;
          throw Error('invalid_frame');
        }
        return c.history(q);
      },
    }));
    cleanup.push(() => {
      released.open();
      ui.app.stop();
    });
    const prompt = kind === 'message' ? 'room post' : '@dev respond';
    const sending = ui.send(prompt);
    await selected.wait;
    expect(ui.app.frame()).toContain(admitted!.messageId);
    if (admitted!.runId) expect(ui.app.frame()).toContain(admitted!.runId);
    released.open();
    await sending;
    expect(ui.app.ui.status).not.toMatch(/error:/);
    await vi.waitFor(() => expect(ui.app.frame()).toContain('invalid_frame'));
    await ui.send(prompt);
    expect(submissions).toBe(1);
    fail = false;
    await vi.waitFor(
      () =>
        expect(
          ui.app.selectedRun()?.stream.some((m) => m.kind === 'user' && m.text === prompt),
        ).toBe(true),
      { timeout: 3000 },
    );
    expect(await f.peer.history(f.scope)).toHaveLength(kind === 'message' ? 1 : 2);
  },
);

it.each(['delayed ack', 'busy review'])(
  'cancels only the displayed selection/version during %s',
  async (mode) => {
    const f = await setup();
    const a = await f.peer.submit({ ...f.scope, requestId: 'first', text: '@dev finish' });
    await vi.waitFor(async () =>
      expect(await f.peer.getRun({ ...f.scope, runId: a.runId! })).toMatchObject({
        turnStatus: 'completed',
      }),
    );
    const blocked = gate(),
      release = gate();
    const cancels: LocalCancelRequest[] = [];
    const ui = await remoteTerminal(f.profile, f.scope.roomId, undefined, (c) => ({
      ...c,
      submit: async (q) => {
        const b = await c.submit(q);
        if (mode === 'delayed ack') {
          blocked.open();
          await release.wait;
        }
        return b;
      },
      reviewRoom: async (q) => {
        blocked.open();
        await release.wait;
        return c.reviewRoom(q);
      },
      cancelRun: (q) => {
        cancels.push(q);
        return c.cancelRun(q);
      },
    }));
    cleanup.push(() => {
      release.open();
      ui.app.stop();
    });
    const sending = ui.send('@ops wait');
    if (mode === 'busy review') {
      await sending;
      void ui.send('/review');
    }
    await blocked.wait;
    await vi.waitFor(
      () => expect(ui.book.runs.some((r) => r.remote?.taskStatus === 'running')).toBe(true),
      { timeout: 3000 },
    );
    // Choose A during B's pending acknowledgement, or the live B during a pending read.
    ui.input.write(mode === 'delayed ack' ? '\x1bOQ\x1b[F\x1b[H\r' : '\x1bOQ\x1b[H\x1b[F\r');
    const displayed = ui.app.selectedRun()!.remote!;
    if (mode === 'delayed ack') expect(displayed.runId).toBe(a.runId);
    else expect(displayed.taskStatus).toBe('running');
    ui.input.write('\x1b');
    await vi.waitFor(
      () =>
        expect(cancels).toMatchObject([
          { runId: displayed.runId, expectedVersion: displayed.version },
        ]),
      { timeout: 900 },
    );
    if (mode === 'delayed ack')
      await vi.waitFor(() => expect(ui.app.ui.status).toContain('error:'));
    expect(ui.app.ui.busy).toBe(true);
    release.open();
    await sending;
    await ui.app.idle();
  },
);
