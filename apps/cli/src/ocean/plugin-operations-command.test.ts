import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { oceanArguments } from './arguments.js';
import { runPluginOperationsCommand } from './plugin-operations-command.js';

const operation = {
  id: 'op_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  connectionGeneration: 2,
  endpoint: 'https://api.githubcopilot.com/mcp/',
  tool: 'list_issues',
  repository: 'team/api',
  schemaDigest: 'b'.repeat(64),
  argumentsDigest: 'c'.repeat(64),
  arguments: '{"owner":"team","repo":"api"}',
  state: 'uncertain' as const,
  outcomeCode: 'transport_failure',
  detail: 'connection lost after dispatch',
  resultSummary: null,
  resultBytes: null,
  truncated: false,
  revision: 2,
  createdAt: '2026-11-04T00:00:00.000Z',
  settledAt: '2026-11-04T00:00:01.000Z',
  acknowledgedAt: null,
  acknowledgedReason: null,
};

function sink(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, text: () => chunks.join('') };
}

function client(overrides: Partial<LocalRuntimeClient> = {}): LocalRuntimeClient {
  return {
    async pluginOperationsList() {
      return [operation];
    },
    async pluginOperationShow() {
      return operation;
    },
    async pluginOperationAcknowledge(request: { expectedRevision: number }) {
      return {
        ...operation,
        state: 'acknowledged' as const,
        revision: request.expectedRevision + 1,
      };
    },
    ...overrides,
  } as unknown as LocalRuntimeClient;
}

describe('ocean plugin operations', () => {
  it('lists and shows operations as bounded human lines', async () => {
    const list = sink();
    const listed = await runPluginOperationsCommand(
      client(),
      oceanArguments(['plugin', 'operations', '--room', 'room_1', '--state', 'uncertain']),
      list.output,
    );
    expect(listed.code).toBe(0);
    expect(list.text()).toContain('op_1');
    expect(list.text()).toContain('uncertain');
    expect(list.text()).toContain('list_issues');
    const show = sink();
    const shown = await runPluginOperationsCommand(
      client(),
      oceanArguments(['plugin', 'operations', 'show', '--operation', 'op_1']),
      show.output,
    );
    expect(shown.code).toBe(0);
    expect(show.text()).toContain('endpoint=https://api.githubcopilot.com/mcp/');
    expect(show.text()).toContain('repo=team/api');
    expect(show.text()).toContain('gen=2');
  });

  it('acknowledges with the explicit revision and never claims certainty', async () => {
    const out = sink();
    const result = await runPluginOperationsCommand(
      client(),
      oceanArguments([
        'plugin',
        'operations',
        'acknowledge',
        '--operation',
        'op_1',
        '--revision',
        '2',
        '--reason',
        'checked',
      ]),
      out.output,
    );
    expect(result.code).toBe(0);
    expect(out.text()).toContain('acknowledged');
    expect(out.text()).toContain('stays unknown and is not retried');
    expect((result.data as { state: string }).state).toBe('acknowledged');
  });

  it('refuses a missing revision and invalid filters before any request', async () => {
    await expect(
      runPluginOperationsCommand(
        client(),
        oceanArguments(['plugin', 'operations', 'acknowledge', '--operation', 'op_1']),
        sink().output,
      ),
    ).rejects.toThrow(/Invalid or duplicate option|Missing --revision/);
    await expect(
      runPluginOperationsCommand(
        client(),
        oceanArguments(['plugin', 'operations', 'list', '--state', 'done']),
        sink().output,
      ),
    ).rejects.toThrow('invalid_input');
    // --json never prints human prose; the runtime envelope stays the only output.
    const out = sink();
    await runPluginOperationsCommand(
      client(),
      oceanArguments(['plugin', 'operations', 'list', '--json']),
      out.output,
    );
    expect(out.text()).toBe('');
  });
});
