import { registeredCodingTools } from './coding-project-host.js';
import { isRestored } from './restored.js';
import type { ProviderPort } from '@runnets/application';
import type { Readable, Writable } from 'node:stream';
import { TuiApp } from '../tui/app.js';
import { createProviderFromEnv } from '../engine/provider.js';
import { openOceanProfile } from './profile.js';
import { ChatRunBook } from './chat-book.js';

export interface DirectTuiOptions {
  readonly profile?: string | undefined;
  readonly roomId: string;
  readonly taskId?: string;
  readonly provider?: ProviderPort | null | undefined;
  readonly input?: Readable;
  readonly output?: Writable;
}
/** Keep the profile owned until any streamed model request has settled and raw mode is restored. */
export async function runDirectTui(options: DirectTuiOptions): Promise<number> {
  if (isRestored(options.profile)) throw new Error('restore_restricted');
  let app: TuiApp | undefined;
  const configured = registeredCodingTools(options.profile);
  const runtime = openOceanProfile(
    options.profile,
    false,
    options.taskId === undefined
      ? {}
      : {
          codingTools: {
            ...configured,
            owner: (_turn, signal) =>
              app?.codingOwner(signal) ?? { decide: () => Promise.resolve('cancel' as const) },
          },
        },
  );
  const shutdown = () => app?.stop();
  process.on('SIGTERM', shutdown);
  try {
    await runtime.ready;
    const provider =
      options.provider === undefined ? createProviderFromEnv(process.env) : options.provider;
    const room = runtime.conversations.room('ws_ocean', options.roomId);
    if (!room.ok) throw new Error(room.error.code);
    const book = new ChatRunBook(runtime, options.roomId, provider, options.taskId);
    app = new TuiApp({
      service: runtime.service,
      provider,
      book,
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      workspace: room.value.kind === 'group' ? room.value.title : options.roomId,
    });
    await app.start();
    await app.whenExit();
    return 0;
  } finally {
    process.off('SIGTERM', shutdown);
    app?.stop();
    await app?.idle();
    runtime.close();
  }
}
