import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { rooms, gatedProvider } from './local-runtime-admission.test.js';
import { PassThrough } from 'node:stream';
import { connectLocalRuntime } from '@runnets/tools-node';
/* eslint-disable no-restricted-imports -- These injected terminal fixtures exercise the same CLI package's source. */
import { RoomConnection } from '../src/ocean/room-connection.js';
import { RemoteChatRunBook } from '../src/ocean/remote-chat-book.js';
import { TuiApp } from '../src/tui/app.js';
import { openOceanProfile } from '../src/ocean/profile.js';
import { startLocalRuntime } from '../src/local-runtime/host.js';
/* eslint-enable no-restricted-imports */

export async function remoteTerminal(
  profile: string,
  room: string,
  taskId?: string,
  decorate = (client: Awaited<ReturnType<typeof connectLocalRuntime>>) => client,
) {
  const connect = async (signal?: AbortSignal) =>
    decorate(await connectLocalRuntime({ profile, signal }));
  const book = new RemoteChatRunBook(new RoomConnection(await connect(), connect), room, taskId);
  const input = Object.assign(new PassThrough(), { isTTY: true }),
    output = Object.assign(new PassThrough(), { isTTY: true, columns: 128, rows: 16 });
  output.resume();
  const app = new TuiApp({ input, output, book, size: { columns: 128, rows: 16 } });
  await app.start();
  return {
    app,
    input,
    book,
    resize(columns: number, rows: number) {
      Object.assign(output, { columns, rows });
      output.emit('resize');
    },
    send: async (prompt: string) => {
      input.write(prompt + '\r');
      await app.idle();
    },
  };
}

export function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { open, wait };
}
export async function roomProfileFixture(cleanup: (() => void | Promise<void>)[]) {
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
