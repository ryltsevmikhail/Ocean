// Synthetic owner for native shutdown and detach qualification; launched with an isolated environment.
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { appendFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { ProviderPort } from '@runnets/application';
const profile = process.argv[2]!;
const provider: ProviderPort = {
  id: 'test',
  models: ['test'],
  capabilities: { streaming: true, usage: true, reasoning: false },
  stream(request) {
    appendFileSync(profile + '/calls', 'dispatch\n', { flush: true });
    return (async function* () {
      request.signal!.addEventListener(
        'abort',
        () => {
          if (process.argv[3]?.startsWith('cancel')) {
            const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
            try {
              const proof = db
                .prepare(
                  "SELECT 1 FROM command_receipts c JOIN events e ON e.aggregate_id=c.aggregate_id AND e.sequence=c.version WHERE c.command_id='room-cancel-stop-one' AND e.type='task_run.cancelling'",
                )
                .get();
              if (proof) writeSync(1, 'receipt-before-abort\n');
            } finally {
              db.close();
            }
          }
          writeSync(1, 'abort\n');
        },
        { once: true },
      );
      const finish = once(process, 'message');
      yield { type: 'text_delta', text: 'native ' } as const;
      const [outcome] = await finish;
      if (outcome !== 'success') throw Error('synthetic stream failure');
      yield { type: 'text_delta', text: 'fixture answer' } as const;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as const;
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' } as const;
    })();
  },
};
const host = await startLocalRuntime({
  profile,
  provider,
  drainDeadlineMs: process.argv[3] === 'draining_retry' ? 25_000 : 300,
});
writeSync(1, 'ready\n');
await host.closed;
