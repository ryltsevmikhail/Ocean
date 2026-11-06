import type { ChatTurn } from '@runnets/domain';
import { expect, it, vi } from 'vitest';
import { combineChatTools, prepareChatTools } from './chat-turn-tools.js';
import type { GrantedPluginTools } from './plugin-turn-tools.js';
const source = (name: string): GrantedPluginTools => ({
  cleanupConfirmed: true,
  definitions: [{ name, description: name, parameters: { type: 'object' } }],
  execute: vi.fn(async () => ({ isError: false, output: name })),
});
it('combines coding and service names in one loop and deduplicates identity across sources', async () => {
  const coding = source('read'),
    service = source('mcp_alias');
  const tools = combineChatTools(coding, service)!;
  expect(tools.definitions.map((t) => t.name)).toEqual(['read', 'mcp_alias']);
  const signal = new AbortController().signal,
    context = { taskRunId: 'run', attemptId: 'at' };
  const call = { id: 'same', name: 'read', arguments: '{}' };
  expect(await tools.execute(call, signal, context)).toEqual({ isError: false, output: 'read' });
  expect(await tools.execute(call, signal, context)).toEqual({ isError: false, output: 'read' });
  expect((await tools.execute({ ...call, name: 'mcp_alias' }, signal, context)).isError).toBe(true);
  expect(service.execute).not.toHaveBeenCalled();
  expect(await tools.execute({ ...call, id: 'next', name: 'mcp_alias' }, signal, context)).toEqual({
    isError: false,
    output: 'mcp_alias',
  });
  expect(coding.execute).toHaveBeenCalledTimes(1);
});
it('refuses duplicate visible names before a provider or executor can run', () => {
  const a = source('same'),
    b = source('same');
  expect(() => combineChatTools(a, b)).toThrow('duplicate_tool_name');
  expect(a.execute).not.toHaveBeenCalled();
  expect(b.execute).not.toHaveBeenCalled();
});

it('a coding refusal prevents service-only fallback before the existing loop', async () => {
  const turn = { codingTaskId: 'task' } as ChatTurn;
  const grantedTools = { forTurn: vi.fn(async () => source('mcp_alias')) };
  await expect(
    prepareChatTools(
      {
        codingTools: {
          forTurn: async () => {
            throw Error('coding refused');
          },
        },
        grantedTools,
      },
      turn,
      new AbortController().signal,
    ),
  ).rejects.toThrow('coding refused');
  expect(grantedTools.forTurn).not.toHaveBeenCalled();
});

it('bounds the shared invocation identity cache while keeping previous outcomes', async () => {
  const coding = source('read'),
    tools = combineChatTools(coding)!;
  const signal = new AbortController().signal;
  for (let i = 0; i < 1024; i++)
    await tools.execute({ id: String(i), name: 'missing', arguments: '{}' }, signal);
  expect((await tools.execute({ id: 'over', name: 'read', arguments: '{}' }, signal)).output).toBe(
    'turn tool limit reached',
  );
  expect((await tools.execute({ id: '0', name: 'missing', arguments: '{}' }, signal)).output).toBe(
    'tool unavailable',
  );
  expect(coding.execute).not.toHaveBeenCalled();
});
