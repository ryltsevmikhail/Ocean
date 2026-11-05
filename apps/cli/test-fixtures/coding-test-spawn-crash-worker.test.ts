// eslint-disable-next-line no-restricted-imports -- Same-app source contract; child executes dist.
import type * as SourceModule1 from '../src/ocean/profile.js';
// Drive a registered slow preset, then let the parent kill the runtime or the supervised cgroup.
import { writeSync } from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { ProviderPort } from '@runnets/application';
const [profile, room, presetId] = process.argv.slice(2) as [string, string, string, string];
// Test-only observation: name the exact transient systemd unit so the parent can
// clean it up on any failure path instead of orphaning it under a removed fixture.
const spawn = cp.spawn as (...args: unknown[]) => unknown;
(cp as unknown as { spawn: (...args: unknown[]) => unknown }).spawn = (...args) => {
  const argv = args[1];
  if (args[0] === '/usr/bin/systemd-run' && Array.isArray(argv)) {
    const unit = argv.find((value) => String(value).startsWith('--unit='));
    if (unit) writeSync(1, 'unit ' + String(unit).slice(7) + '\n');
  }
  return spawn(...args);
};
syncBuiltinESMExports();
const { openOceanProfile }: typeof SourceModule1 = await import(String('../dist/ocean/profile.js'));
type Task = { worktreeRoot: string | null };
const sandbox = async (task: Task) => ({ root: task.worktreeRoot! });
const owner = () => ({ decide: async () => 'allow-once' as const });
const runtime = openOceanProfile(profile, false, {
  codingTools: { sandbox, inspectSandbox: sandbox, owner },
});
try {
  await runtime.ready;
  let round = 0;
  const calls = [
    { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' },
    { id: 'test', name: 'run_test', arguments: JSON.stringify({ presetId }) },
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
  const outcome = await runtime.chat.send({
    workspaceId: 'ws_ocean',
    roomId: room,
    requestId: 'spawn',
    taskId: 'task',
    to: 'dev',
    text: 'synthetic',
    provider,
    signal: new AbortController().signal,
    emit: () => {},
  });
  writeSync(1, 'send ' + (outcome.ok ? 'ok' : 'refused') + '\n');
  writeSync(1, 'done\n');
} finally {
  runtime.close();
}
