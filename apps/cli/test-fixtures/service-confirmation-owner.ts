// eslint-disable-next-line no-restricted-imports -- Child executes the built normal host.
import type * as HostSource from '../src/local-runtime/host.js';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderPort } from '@runnets/application';
const { startLocalRuntime }: typeof HostSource = await import(
  String('../dist/local-runtime/host.js')
);
const profile = process.argv[2]!;
const provider: ProviderPort = {
  id: 'deepseek',
  models: ['deepseek-flash'],
  capabilities: { streaming: true, reasoning: false, usage: false, toolCalls: true },
  async *stream(request) {
    appendFileSync(join(profile, 'confirmation-model-requests'), 'request\n', { flush: true });
    const tool = request.messages.at(-1);
    if (tool?.role === 'tool') {
      const result = JSON.parse(String(tool.content)) as {
        structuredContent?: { version?: string };
      };
      if (result.structuredContent?.version !== 'alpha')
        throw Error('missing actual service result');
      yield { type: 'text_delta', text: 'verified alpha' };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'scripted' };
    } else {
      if (!request.tools?.[0]) throw Error('service tool missing');
      yield {
        type: 'tool_call',
        call: { id: 'call', name: request.tools[0].name, arguments: '{"value":"alpha"}' },
      };
      yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'scripted' };
    }
  },
};
const host = await startLocalRuntime({ profile, provider });
console.log('ready');
await host.closed;
