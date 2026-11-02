// Synthetic owner for native shutdown and detach qualification; launched with an isolated environment.
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { appendFileSync, writeSync } from 'node:fs';
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
      request.signal!.addEventListener('abort', () => writeSync(1, 'abort\n'), { once: true });
      const [outcome] = await once(process, 'message');
      if (outcome !== 'success') throw Error('synthetic stream failure');
      yield { type: 'text_delta', text: 'native fixture answer' } as const;
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
