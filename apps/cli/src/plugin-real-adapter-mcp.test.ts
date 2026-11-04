/**
 * Task 6 qualification: the real Executor adapter against a loopback GitHub-like
 * MCP server, through the real application services, SQLite stores, admission
 * journal and granted-tool source. The allowed path must produce exactly one
 * business request; a dropped reply must stay uncertain and never redispatch.
 */
import { describe, expect, it } from 'vitest';
import { execute, rig } from '../test-fixtures/real-adapter-rig.js';

describe('real Executor adapter against a loopback GitHub-like MCP server', () => {
  it('qualifies the shipped transport and the frozen card', async () => {
    const r = await rig();
    const qualification = r.queue.transport.qualification();
    expect(qualification.qualified).toBe(true);
    expect(qualification.identities['@executor-js/sdk']).toBe('1.6.11');
    expect(r.queue.adapter.sdkVersion).toBe('1.6.11');
    expect(r.queue.qualified).toBe(true);
  });

  it('reads one issue through a normal chat turn with exactly one business request', async () => {
    const r = await rig();
    const before = r.server.counts.toolCalls;
    const result = await execute(r, 'issue_read', { issue_number: 7 });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Composer loses focus');
    expect(r.server.counts.toolCalls - before).toBe(1);
    expect(r.invokeOptions).toContain(30_000);
    const operation = r.operations.list()[0]!;
    expect(operation).toMatchObject({
      tool: 'issue_read',
      repository: 'team/api',
      connectionGeneration: 1,
      state: 'observed',
      outcomeCode: 'ok',
    });
    expect(operation.endpoint).toBe('https://api.githubcopilot.com/mcp/');
    // One repository only: the adapter received exactly the granted repository.
    expect(r.server.counts.issueReadCalls).toBe(1);
  });

  it('keeps a dropped tool reply uncertain and never redispatches it', async () => {
    const r = await rig({ scenario: 'dropToolReply' });
    const before = r.server.counts.toolCalls;
    const first = await execute(r, 'issue_read', { issue_number: 7 });
    expect(first.uncertain).toBe(true);
    expect(r.server.counts.toolCalls - before).toBe(1);
    const operation = r.operations.list()[0]!;
    expect(operation.state).toBe('uncertain');
    const second = await execute(r, 'issue_read', { issue_number: 7 }, 'call_2');
    expect(second.isError).toBe(true);
    expect(r.server.counts.toolCalls - before).toBe(1);
    expect(r.operations.list()).toHaveLength(1);
    expect(r.operations.openCount()).toBe(1);
  });
});
