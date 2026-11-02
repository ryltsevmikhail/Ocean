import { PassThrough } from 'node:stream';
import { connectLocalRuntime } from '@runnets/tools-node';
/* eslint-disable no-restricted-imports -- These injected terminal fixtures exercise the same CLI package's source. */
import { RoomConnection } from '../src/ocean/room-connection.js';
import { RemoteChatRunBook } from '../src/ocean/remote-chat-book.js';
import { TuiApp } from '../src/tui/app.js';
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
