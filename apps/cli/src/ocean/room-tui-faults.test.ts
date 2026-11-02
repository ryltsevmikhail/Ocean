import { afterEach, expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { LocalCancelRequest, LocalTurnReceipt } from '@runnets/contracts';
import {
  gate,
  roomProfileFixture,
  remoteTerminal,
} from '../../test-fixtures/remote-terminal.test.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
const setup = () => roomProfileFixture(cleanup);

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

it.each(['compact', 'clipped'])(
  'withholds remote cancellation when the %s frame hides a new version',
  async (mode) => {
    const f = await setup();
    const first = await f.peer.submit({ ...f.scope, requestId: 'a', text: '@dev first' });
    await vi.waitFor(async () =>
      expect((await f.peer.getRun({ ...f.scope, runId: first.runId! }))?.turnStatus).toBe(
        'completed',
      ),
    );
    const receipt = await f.peer.submit({ ...f.scope, requestId: 'b', text: '@ops wait' }),
      runId = receipt.runId!;
    const cancels: LocalCancelRequest[] = [];
    const ui = await remoteTerminal(f.profile, f.scope.roomId, undefined, (c) => ({
      ...c,
      cancelRun: (q) => {
        cancels.push(q);
        return c.cancelRun(q);
      },
    }));
    cleanup.push(() => ui.app.stop());
    await vi.waitFor(() => expect(ui.app.selectedRun()?.remote?.taskStatus).toBe('running'));
    ui.resize(mode === 'compact' ? 80 : runId.length + 1, mode === 'compact' ? 6 : 16);
    const before = ui.app.frame(),
      previous = ui.app.selectedRun()!.remote!.version;
    await f.peer.cancelRun({
      ...f.scope,
      runId,
      requestId: 'peer-cancel',
      expectedVersion: previous,
    });
    await vi.waitFor(
      () => expect(ui.app.selectedRun()?.remote?.version).toBeGreaterThan(previous),
      { timeout: 3000 },
    );
    const version = ui.app.selectedRun()!.remote!.version;
    expect(ui.app.frame()).toBe(before);
    expect(before).not.toContain('v' + version);
    ui.input.write('\x03');
    await ui.app.idle();
    expect(cancels).toEqual([]);
    ui.resize((runId + ' [v' + version).length, 16);
    expect(ui.app.frame().split('\n')[1]).toBe(runId + ' [v' + version);
    ui.input.write('\x03');
    await ui.app.idle();
    expect(cancels).toEqual([]);
    ui.resize(128, 16);
    expect(ui.app.frame()).toContain(runId);
    expect(ui.app.frame()).toContain('v' + version);
    ui.input.write('\x03');
    await ui.app.idle();
    expect(cancels).toMatchObject([{ runId, expectedVersion: version }]);
  },
);

it.each(['enter again', 'detach'])(
  'keeps the exact different draft during reconciliation until %s',
  async (mode) => {
    const f = await setup(),
      blocked = gate(),
      release = gate();
    const sent: string[] = [];
    const ui = await remoteTerminal(f.profile, f.scope.roomId, undefined, (c) => ({
      ...c,
      submit: (q) => {
        sent.push(q.text);
        return c.submit(q);
      },
      history: async (q) => {
        if (sent.length) {
          blocked.open();
          await release.wait;
        }
        return c.history(q);
      },
    }));
    cleanup.push(() => {
      release.open();
      ui.app.stop();
    });
    await ui.send('first note');
    await blocked.wait;
    const second = mode === 'detach' ? '  сохранённый черновик  ' : 'second  note\nwith 🌊 inside';
    ui.input.write('\x1b[200~' + second + '\x1b[201~\x1b[D');
    const cursor = ui.app.ui.cursor;
    ui.input.write('\r');
    await ui.app.idle();
    expect(ui.app.ui.prompt).toBe(second);
    expect(ui.app.ui.cursor).toBe(cursor);
    expect(ui.app.ui.status).toMatch(/Enter/i);
    expect(sent).toEqual(['first note']);
    if (mode === 'detach') ui.app.stop();
    release.open();
    if (mode === 'enter again') {
      await vi.waitFor(() =>
        expect(
          ui.app.selectedRun()?.stream.some((m) => m.kind === 'user' && m.text === 'first note'),
        ).toBe(true),
      );
      expect(ui.app.ui.prompt).toBe(second);
      expect(ui.app.ui.status).toMatch(/ready.*Enter/i);
      expect(sent).toEqual(['first note']);
      ui.input.write('\r');
      await ui.app.idle();
      expect(sent).toEqual(['first note', second]);
    } else {
      const reopened = await remoteTerminal(f.profile, f.scope.roomId);
      cleanup.push(() => reopened.app.stop());
      expect(reopened.app.ui.prompt).toBe('');
      expect(
        reopened.app
          .selectedRun()
          ?.stream.filter((m) => m.kind === 'user')
          .map((m) => m.text),
      ).toEqual(['first note']);
    }
    expect((await f.peer.history(f.scope)).map((m) => m.body)).toEqual(sent);
  },
);
