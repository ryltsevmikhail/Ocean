import { PassThrough } from 'node:stream';
import { connectLocalRuntime } from '@runnets/tools-node';
/* eslint-disable no-restricted-imports -- These injected terminal fixtures exercise the same CLI package's source. */
import { RoomConnection } from '../src/ocean/room-connection.js';
import { RemoteChatRunBook } from '../src/ocean/remote-chat-book.js';
import { TuiApp } from '../src/tui/app.js';
/* eslint-enable no-restricted-imports */

export async function remoteTerminal(profile: string, room: string, taskId?: string) {
  const connect = (signal?: AbortSignal) => connectLocalRuntime({ profile, signal });
  const book = new RemoteChatRunBook(new RoomConnection(await connect(), connect), room, taskId);
  const input = Object.assign(new PassThrough(), { isTTY: true }),
    output = Object.assign(new PassThrough(), { isTTY: true });
  output.resume();
  const app = new TuiApp({ input, output, book, size: { columns: 128, rows: 16 } });
  await app.start();
  return {
    app,
    input,
    book,
    send: async (prompt: string) => {
      input.write(prompt + '\r');
      await app.idle();
    },
  };
}
