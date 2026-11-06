import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderPort } from '@runnets/application';
import { startLocalRuntime } from '../dist/local-runtime/host.js';
const profile = process.argv[2];
if (!profile) throw Error('profile required');
let model = 0;
const provider: ProviderPort = {
  id: 'deepseek',
  models: ['deepseek-flash'],
  capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
  async *stream(request) {
    model++;
    await Promise.resolve();
    yield {
      type: 'tool_call',
      call: {
        id: 'unexpected-replay',
        name: request.tools?.[0]?.name ?? 'missing',
        arguments: JSON.stringify({ value: 'alpha' }),
      },
    };
    yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'scripted replay probe' };
  },
};
const host = await startLocalRuntime({ profile, provider });
await delay(100);
const db = new DatabaseSync(join(profile, 'runtime.sqlite'));
const journal = db
  .prepare('SELECT id,tool,task_run_id,attempt_id,outcome FROM tool_invocations_v2')
  .all();
db.close();
console.log(JSON.stringify({ model, journal, stopped: await host.stop() }));
