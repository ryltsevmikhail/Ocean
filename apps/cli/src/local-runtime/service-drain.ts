import type { Runtime } from '../runtime.js';
import { drainBeforeDeadline } from './drain.js';
/** Failed startup retains SQLite ownership while actual transport work is pending. */
export async function failedStartupDrain(runtime: Runtime, deadlineMs: number): Promise<void> {
  const work = (async () => {
    const result = await runtime.services?.drain();
    if (result === 'uncertain') return 'uncertain' as const;
    await runtime.pluginRuntime?.shutdown();
    runtime.close();
    return 'settled' as const;
  })();
  if ((await drainBeforeDeadline(() => work, deadlineMs)) !== 'settled')
    throw Error('stop_incomplete');
}
