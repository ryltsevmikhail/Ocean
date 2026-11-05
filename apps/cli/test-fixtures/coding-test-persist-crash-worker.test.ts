// eslint-disable-next-line no-restricted-imports -- Same-app source contract; child executes dist.
import type * as SourceModule1 from '../src/ocean/profile.js';
// Halt the real test pipeline after durable evidence and before journal settlement.
import { writeSync } from 'node:fs';
import type { ProviderPort } from '@runnets/application';
const [profile, room] = process.argv.slice(2) as [string, string];
const halt = (at: string): never => {
  writeSync(1, at + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error('halt returned');
};
const { openOceanProfile }: typeof SourceModule1 = await import(String('../dist/ocean/profile.js'));
type Task = { worktreeRoot: string | null };
const sandbox = async (task: Task) => ({ root: task.worktreeRoot! });
const owner = () => ({ decide: async () => 'allow-once' as const });
const runtime = openOceanProfile(profile, false, {
  codingTools: { sandbox, inspectSandbox: sandbox, owner },
});
try {
  await runtime.ready;
  const evidence = runtime.codingEvidence;
  if (!evidence) throw Error('fixture evidence store');
  const put = evidence.put.bind(evidence);
  evidence.put = (value) => {
    put(value);
    halt('evidence');
  };
  let round = 0;
  const calls = [
    { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' },
    { id: 'test', name: 'run_test', arguments: '{"presetId":"test"}' },
  ];
  const provider: ProviderPort = {
    id: 'fixture',
    models: ['fixture'],
    capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
    async *stream() {
      const call = calls[round++];
      if (call) yield { type: 'tool_call', call };
      else yield { type: 'text_delta', text: 'fixture' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield {
        type: 'completed',
        stopReason: call ? 'tool_calls' : 'stop',
        rawStopReason: call ? 'tool_calls' : 'stop',
      };
    },
  };
  writeSync(1, 'ready\n');
  await runtime.chat.send({
    workspaceId: 'ws_ocean',
    roomId: room,
    requestId: 'persist',
    taskId: 'task',
    to: 'dev',
    text: 'synthetic',
    provider,
    signal: new AbortController().signal,
    emit: () => {},
  });
  writeSync(1, 'done\n');
} finally {
  runtime.close();
}
