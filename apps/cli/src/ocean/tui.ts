import { connectLocalRuntime } from '@runnets/tools-node';
import type { Readable, Writable } from 'node:stream';
import { TuiApp } from '../tui/app.js';
import { profileDirectory } from './profile.js';
import { isRestored } from './restored.js';
import { RoomConnection } from './room-connection.js';
import { RemoteChatRunBook } from './remote-chat-book.js';
export interface DirectTuiOptions {
  readonly profile?: string | undefined;
  readonly roomId: string;
  readonly taskId?: string;
  readonly input?: Readable;
  readonly output?: Writable;
}
/** A room terminal owns only its authenticated connection. */
export async function runDirectTui(options: DirectTuiOptions): Promise<number> {
  const restored = isRestored(options.profile);
  const profile = profileDirectory(options.profile);
  const connect = (signal?: AbortSignal) => connectLocalRuntime({ profile, signal });
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect();
  } catch (error) {
    // A restored profile without a maintenance host remains refused with its historical code.
    if (restored) throw Error('restore_restricted');
    throw error;
  }
  if (restored && !client.identity.capabilities.includes('restore.maintenance')) {
    client.close();
    throw Error('restore_restricted');
  }
  const connection = new RoomConnection(client, connect);
  const book = new RemoteChatRunBook(connection, options.roomId, options.taskId);
  const input = options.input ?? process.stdin;
  const app = new TuiApp({
    book,
    input,
    output: options.output ?? process.stdout,
  });
  const shutdown = () => app.stop();
  let lostTerminal = false;
  const hangup = () => {
    lostTerminal = true;
    app.stop();
    input.destroy();
  };
  const inputError = (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EIO' || (error.syscall !== 'read' && error.syscall !== 'setRawMode'))
      throw error;
    hangup();
  };
  const closed = () => input.off('error', inputError);
  input.on('error', inputError);
  input.once('close', closed);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', hangup);
  try {
    await app.start();
    await app.whenExit();
    return 0;
  } catch (error) {
    if (
      lostTerminal &&
      error instanceof Error &&
      (error.name === 'AbortError' || error.message === 'connection_closed')
    )
      return 0;
    throw error;
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGHUP', hangup);
    app.stop();
    try {
      await app.idle();
    } finally {
      // The command's real terminal may still have an outstanding libuv read after pause().
      // Keep its error handler through the stream close, including after cooked-mode restoration.
      if (input === process.stdin && process.stdin.isTTY) input.destroy();
      if (!input.destroyed) {
        input.off('close', closed);
        closed();
      }
    }
  }
}
