import { writeFileSync, unlinkSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { connectLocalRuntime, localRuntimePaths } from '@runnets/tools-node';
import { gate, roomProfileFixture } from '../../test-fixtures/remote-terminal.test.js';
import { RoomConnection } from './room-connection.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

it.each(['publication', 'detach'])(
  'keeps reconnecting across a partial endpoint until %s',
  async (outcome) => {
    const f = await roomProfileFixture(cleanup);
    f.peer.close();
    expect(await f.host.stop()).toMatchObject({ outcome: 'complete' });
    await f.host.closed;
    const paths = localRuntimePaths(f.profile);
    // Descriptor readers must refuse this genuine, owned publication gap as
    // endpoint_exists rather than permit an offline owner or mutate the endpoint.
    const staged = paths.directory + '/.connection-partial';
    writeFileSync(staged, 'synthetic publication', { mode: 0o600 });
    cleanup.push(() => {
      try {
        unlinkSync(staged);
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
      }
    });
    await expect(connectLocalRuntime({ profile: f.profile })).rejects.toThrow('endpoint_exists');
    const attempted = gate();
    const connection = new RoomConnection(f.peer, async (signal) => {
      attempted.open();
      return connectLocalRuntime({ profile: f.profile, signal });
    });
    cleanup.push(() => connection.close());
    // Attach both handlers immediately: a terminal reconnect failure is the
    // assertion result, never an unhandled rejection during the next startup.
    const read = connection
      .withClient((c) => c.status())
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    await attempted.wait;
    // Let the rejected descriptor read enter the cancellable reconnect backoff.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (outcome === 'detach') {
      connection.close();
      expect((await read).error).toMatchObject({ name: 'AbortError' });
    } else {
      unlinkSync(staged);
      const second = await f.start();
      cleanup.push(async () => {
        await second.stop();
        await second.closed;
      });
      expect(await read).toMatchObject({ value: { state: 'ready' }, error: null });
    }
  },
);

it('does not retry an endpoint_exists result from an already connected operation', async () => {
  const f = await roomProfileFixture(cleanup);
  const connection = new RoomConnection(f.peer, () => connectLocalRuntime({ profile: f.profile }));
  cleanup.push(() => connection.close());
  let effects = 0;
  await expect(
    connection.withClient(async (c) => {
      await c.status();
      effects++;
      throw Error('endpoint_exists');
    }),
  ).rejects.toThrow('endpoint_exists');
  expect(effects).toBe(1);
});
