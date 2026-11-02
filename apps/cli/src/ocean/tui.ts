import type { ProviderPort } from '@runnets/application';
import type { Readable, Writable } from 'node:stream';
import { TuiApp } from '../tui/app.js';
import { createProviderFromEnv } from '../engine/provider.js';
import { openOceanProfile } from './profile.js';
import { ChatRunBook } from './chat-book.js';

export interface DirectTuiOptions {
  readonly profile?: string | undefined;
  readonly roomId: string;
  readonly provider?: ProviderPort | null | undefined;
  readonly input?: Readable;
  readonly output?: Writable;
}
/** Keep the profile owned until any streamed model request has settled and raw mode is restored. */
export async function runDirectTui(options: DirectTuiOptions): Promise<number> {
  const runtime = openOceanProfile(options.profile);
  let app: TuiApp | undefined;
  const shutdown = () => app?.stop();
  process.on('SIGTERM', shutdown);
  try {
    await runtime.ready;
    const provider =
      options.provider === undefined ? createProviderFromEnv(process.env) : options.provider;
    const book = new ChatRunBook(runtime, options.roomId, provider);
    app = new TuiApp({
      service: runtime.service,
      provider,
      book,
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      workspace: options.roomId,
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
