import type { ProjectChatScope } from './project-chat-scope.js';
import { LOCAL_CODING_WORKSPACE } from '@runnets/contracts';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { Readable, Writable } from 'node:stream';
import { TuiApp } from '../tui/app.js';
import { profileDirectory } from './profile.js';
import { isRestored } from './restored.js';
import { RoomConnection } from './room-connection.js';
import { RemoteChatRunBook } from './remote-chat-book.js';
export interface TuiStreams {
  readonly profile?: string | undefined;
  readonly input?: Readable;
  readonly output?: Writable;
}
type Target =
  | { readonly roomId: string; readonly taskId?: string; readonly project?: never }
  | { readonly roomId: string; readonly taskId?: never; readonly project: ProjectChatScope };
export type DirectTuiSelector = (
  connection: RoomConnection,
  input: Readable,
  output: Writable,
  signal: AbortSignal,
) => Promise<Target | undefined>;
export type DirectTuiOptions = TuiStreams & (Target | { readonly select: DirectTuiSelector });
/** A room terminal owns only its authenticated connection. */
export async function runDirectTui(options: DirectTuiOptions): Promise<number> {
  const restored = isRestored(options.profile);
  const profile = profileDirectory(options.profile);
  const connect = async (signal?: AbortSignal) => {
    const client = await connectLocalRuntime({ profile, signal });
    if ('select' in options && !client.identity.capabilities.includes(LOCAL_CODING_WORKSPACE)) {
      client.close();
      throw Error('project_runtime_upgrade_required');
    }
    return client;
  };
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
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const selecting = 'select' in options ? new AbortController() : undefined;
  let app: TuiApp | undefined;
  const shutdown = () => {
    selecting?.abort();
    app?.stop();
    if (!app) connection.close();
  };
  let lostTerminal = false;
  const hangup = () => {
    lostTerminal = true;
    shutdown();
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
  if (selecting) {
    process.on('SIGINT', shutdown);
    input.once('end', shutdown);
    if (input.readableEnded) shutdown();
  }
  try {
    const target =
      'select' in options
        ? await options.select(connection, input, output, selecting!.signal)
        : options;
    if (!target || selecting?.signal.aborted) return 0;
    if (selecting) input.off('end', shutdown);
    const book = new RemoteChatRunBook(connection, target.roomId, target.taskId, target.project);
    app = new TuiApp({ book, input, output });
    const started = app.start();
    if (selecting) input.resume();
    await started;
    await app.whenExit();
    return 0;
  } catch (error) {
    if (
      (lostTerminal || selecting?.signal.aborted) &&
      error instanceof Error &&
      (error.name === 'AbortError' || error.message === 'connection_closed')
    )
      return 0;
    throw error;
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGHUP', hangup);
    if (selecting) {
      process.off('SIGINT', shutdown);
      input.off('end', shutdown);
    }
    shutdown();
    try {
      await app?.idle();
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
