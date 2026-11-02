import { taskRunId } from '@runnets/domain';
import { createRuntimeFromEnv } from './runtime.js';

/** Inspect authoritative state and unresolved effect metadata; never auto-resume or replay. */
export async function runStatus(argv: readonly string[]): Promise<number> {
  const runtime = createRuntimeFromEnv();
  try {
    await runtime.ready;
    if (argv.length > 1) throw new Error('Usage: runne status [taskRunId]');
    const ids = argv[0] === undefined ? await runtime.service.listTaskRuns() : [taskRunId(argv[0])];
    process.stdout.write(
      `Storage: ${runtime.durable ? 'durable' : 'ephemeral (no restart recovery)'}\n`,
    );
    for (const id of ids) {
      const state = await runtime.service.state(id);
      process.stdout.write(`${id}: ${state.status}\n`);
      if (state.status === 'reconciling' || state.status === 'cancelling')
        process.stdout.write('  User review required; execution/history cannot safely resume.\n');
    }
    for (const effect of (await runtime.toolJournal?.pending()) ?? [])
      process.stdout.write(
        `Effect ${effect.id}: ${effect.outcome} (${effect.taskRunId || 'legacy/unscoped'}, ${effect.attemptId || 'unknown attempt'})\n`,
      );
    return 0;
  } finally {
    runtime.close();
  }
}
