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
  if (isRestored(options.profile)) throw Error('restore_restricted');
  const profile = profileDirectory(options.profile);
  const connect = (signal?: AbortSignal) => connectLocalRuntime({ profile, signal });
  const connection = new RoomConnection(await connect(), connect);
  const book = new RemoteChatRunBook(connection, options.roomId, options.taskId);
  const app = new TuiApp({
    book,
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
  });
  const shutdown = () => app.stop();
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  try {
    await app.start();
    await app.whenExit();
    return 0;
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGHUP', shutdown);
    app.stop();
    await app.idle();
  }
}
