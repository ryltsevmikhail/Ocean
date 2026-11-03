import { expect, it } from 'vitest';
import { CodingTurnTools } from './coding-turn-tools.js';
import { CodingApprovalService } from './coding-approval.js';
import { ToolError, type ToolInvocation } from './tools.js';
it('exposes preset IDs and refuses arbitrary command arguments before preparation', async () => {
  const prepared: ToolInvocation[] = [];
  const tools = new CodingTurnTools({
    definitions: [{ name: 'run_command', description: 'legacy shell', parameters: {} }],
    presets: [{ id: 'test', program: '/pnpm', args: ['test'], cwd: '.' }],
    approvals: new CodingApprovalService({
      store: {
        atomic: () => {
          throw Error('unexpected approval');
        },
      },
      now: () => 100,
      admit: () => false,
      restored: false,
    }),
    owner: { decide: async () => 'deny' },
    journal: { claim: async () => false, settle: async () => {} },
    taskRunId: 'run',
    nextId: () => 'approval',
    admit: () => true,
    read: async () => ({ isError: false, output: 'read' }),
    prepare: async (_id, call) => {
      prepared.push(call);
      throw new ToolError('fixture', 'stop before dispatch');
    },
  });
  expect(tools.definitions.map((t) => t.name)).toEqual(['run_test']);
  const context = { taskRunId: 'run', attemptId: 'attempt' },
    signal = new AbortController().signal;
  await tools.execute({ id: 'shell', name: 'run_command', arguments: '{}' }, signal, context);
  await tools.execute(
    { id: 'extra', name: 'run_test', arguments: '{"presetId":"test","args":["evil"]}' },
    signal,
    context,
  );
  expect(prepared).toEqual([]);
  const call = { id: 'preset', name: 'run_test', arguments: '{"presetId":"test"}' };
  await tools.execute(call, signal, context);
  await tools.execute(call, signal, context);
  expect(prepared).toEqual([
    {
      id: 'preset',
      name: 'run_command',
      arguments: '{"program":"/pnpm","args":["test"],"cwd":"."}',
    },
  ]);
  await tools.execute({ ...call, id: 'foreign' }, signal, { ...context, taskRunId: 'other' });
  expect(prepared).toHaveLength(1);
});
