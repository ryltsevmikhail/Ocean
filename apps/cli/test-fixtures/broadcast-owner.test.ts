// Synthetic broadcast owner for crash/restart qualification; launched with an isolated environment.
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { appendFileSync, writeSync } from 'node:fs';
import type { ProviderPort } from '@runnets/application';

const profile = process.argv[2]!;
const scenario = process.argv[3] ?? 'fast';
const calls = profile + '/calls';
appendFileSync(calls, '');
let dispatch = 0;
const provider: ProviderPort = {
  id: 'deepseek',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  capabilities: { streaming: true, usage: true, reasoning: false },
  stream() {
    dispatch += 1;
    const index = dispatch;
    appendFileSync(calls, 'dispatch ' + String(index) + '\n', { flush: true });
    if (scenario === 'successor') throw Error('unexpected successor provider dispatch');
    const holds =
      (scenario === 'hold-first' && index === 1) || (scenario === 'hold-second' && index === 2);
    return (async function* () {
      if (holds) await new Promise<void>((resolve) => process.once('message', () => resolve()));
      yield { type: 'text_delta', text: 'exception answer ' + String(index) } as const;
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as const;
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' } as const;
    })();
  },
};
const host = await startLocalRuntime({ profile, provider, drainDeadlineMs: 300 });
writeSync(1, 'ready\n');
await host.closed;
