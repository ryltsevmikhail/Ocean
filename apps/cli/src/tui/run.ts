/**
 * `runne tui` — full-screen terminal host.
 *
 * Streams and the service are injectable so the whole UI can be driven from
 * tests, while the command itself wires stdin/stdout and the environment
 * provider. RUNNE_DB selects durable storage; pending turns settle before close.
 * The terminal is restored in a `finally`: a failure during startup
 * must not leave the user in the alternate screen or raw mode.
 */

import { createNativeBackend, WorkspaceTools } from '@runnets/tools-node';
import type { Readable, Writable } from 'node:stream';

import type { TaskRunService } from '@runnets/application';
import type { ProviderPort } from '@runnets/provider-core';

import { requireContainmentFromEnv } from '../tools.js';
import { createProviderFromEnv } from '../engine/provider.js';
import { createRuntimeFromEnv } from '../runtime.js';
import { TuiApp } from './app.js';
import type { Size } from './types.js';

export interface TuiRunOptions {
  readonly workspace?: string | undefined;
  readonly input?: Readable | undefined;
  readonly output?: Writable | undefined;
  readonly service?: TaskRunService | undefined;
  /** Explicit provider; `undefined` resolves one from the environment. */
  readonly provider?: ProviderPort | null | undefined;
  readonly size?: Size | undefined;
}

/** Run the TUI until the user quits and return the process exit code. */
export async function runTui(options: TuiRunOptions = {}): Promise<number> {
  const runtime = options.service === undefined ? createRuntimeFromEnv() : null;
  const service = options.service ?? runtime?.service;
  if (service === undefined) throw new Error('TUI runtime service is unavailable');
  let app: TuiApp | undefined;
  try {
    const recovery = await runtime?.ready;
    app = new TuiApp({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      service,
      recovered: recovery?.tasks.map((task) => task.taskRunId),
      workspace: options.workspace ?? process.cwd(),
      executor:
        options.service === undefined
          ? new WorkspaceTools(await createNativeBackend(options.workspace ?? process.cwd()), {
              requireContainment: requireContainmentFromEnv(),
            })
          : undefined,
      journal: runtime?.toolJournal,
      provider:
        options.provider === undefined ? createProviderFromEnv(process.env) : options.provider,
      size: options.size,
    });
    await app.start();
    await app.whenExit();
    return 0;
  } finally {
    app?.stop();
    try {
      await app?.idle();
    } finally {
      runtime?.close();
    }
  }
}
