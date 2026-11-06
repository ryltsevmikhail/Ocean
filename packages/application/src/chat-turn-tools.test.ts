import { createHash } from 'node:crypto';
import type { ChatTurn } from '@runnets/domain';
import { expect, it, vi } from 'vitest';
import { combineChatTools, prepareChatTools } from './chat-turn-tools.js';
import type { GrantedPluginTools } from './plugin-turn-tools.js';
const source = (name: string): GrantedPluginTools & { callDigest(text: string): string } => ({
  callDigest: (text: string) => createHash('sha256').update(text).digest('hex'),
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
    tools = combineChatTools(coding, source('mcp_alias'))!;
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

it('keeps lone source contracts and stores fixed-size identities for oversized unknown calls', async () => {
  const a = source('read'),
    b = source('mcp_alias');
  const tools = combineChatTools(a, b)!;
  const call = { id: 'huge', name: 'unknown', arguments: 'x'.repeat(1048577) },
    signal = new AbortController().signal;
  const writes = vi.spyOn(Map.prototype, 'set');
  const refused = tools.execute(call, signal);
  expect(tools.execute(call, signal)).toBe(refused);
  expect(
    (await tools.execute({ ...call, name: 'read', arguments: '{}' }, signal)).output,
  ).toContain('identity conflict');
  const retained = writes.mock.calls.filter(
    ([, value]) => value && typeof value === 'object' && 'fingerprint' in value,
  );
  writes.mockRestore();
  expect(retained).toHaveLength(1);
  expect(String(retained[0]![0])).toHaveLength(64);
  expect((retained[0]![1] as { fingerprint: string }).fingerprint).toHaveLength(64);
  expect(a.execute).not.toHaveBeenCalled();
});

it('returns a lone source without replacing its own identity and refusal contract', () => {
  const single = Object.assign(source('read'), { ownCallIdentity: true as const });
  expect(combineChatTools(single)).toBe(single);
});

it('keeps coding/dev single-source payload refusal guards when the source has no own identity contract', async () => {
  const dev = source('read'),
    tools = combineChatTools(dev)!;
  const call = { id: 'same', name: 'read', arguments: '{}' },
    signal = new AbortController().signal;
  expect(tools).not.toBe(dev);
  const first = tools.execute(call, signal);
  expect(tools.execute(call, signal)).toBe(first);
  expect((await tools.execute({ ...call, arguments: '{"changed":true}' }, signal)).isError).toBe(
    true,
  );
  expect(
    (await tools.execute({ ...call, id: 'oversize', arguments: 'x'.repeat(1048577) }, signal))
      .output,
  ).toBe('tool arguments too large');
  expect((await tools.execute({ ...call, id: 'unlisted', name: 'unlisted' }, signal)).output).toBe(
    'tool unavailable',
  );
  expect(dev.execute).toHaveBeenCalledTimes(1);
});

it('refuses an unmarked source without a trusted digest before any counted dispatch', async () => {
  const calls: string[] = [];
  const plain: GrantedPluginTools = {
    cleanupConfirmed: true,
    definitions: [{ name: 'allowed', description: 'counted', parameters: { type: 'object' } }],
    execute: async (call) => {
      calls.push(call.name);
      return { isError: false, output: 'counted effect' };
    },
  };
  let tools: GrantedPluginTools | undefined, failure: string | undefined;
  try {
    tools = combineChatTools(plain);
  } catch (error) {
    failure = (error as Error).message;
  }
  if (tools) {
    const call = { id: 'same', name: 'allowed', arguments: '{}' },
      signal = new AbortController().signal;
    await tools.execute(call, signal);
    await tools.execute(call, signal);
    await tools.execute({ ...call, arguments: '{"changed":true}' }, signal);
    await tools.execute({ ...call, id: 'unlisted', name: 'unlisted' }, signal);
  }
  expect(calls).toEqual([]);
  expect(failure).toBe('tool_digest_required');
});
