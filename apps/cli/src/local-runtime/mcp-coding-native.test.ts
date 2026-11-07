import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OwnerScopeService, type ProviderPort } from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { codingWorkflowFixture } from '../ocean/coding-workflow-fixture.js';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { connection } from '../../../../packages/integrations-mcp/test-fixtures/admission.js';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'reads its assigned coding worktree and calls one owner-granted service in the same existing turn',
  async () => {
    const f = await codingWorkflowFixture('direct');
    const http = await httpFixture('normal', undefined, 60000);
    const store = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    const c = connection({ kind: 'http', url: http.url.href });
    const owned = { ...c, trust: { ...c.trust, ownerId: f.runtime.ownerId! } };
    store.serviceAuthority.atomic((tx) => tx.putConnection(owned, null));
    try {
      await f.runtime.services!.start();
      const bot = store.conversations.atomic((tx) => tx.botByHandle('dev'))!;
      new OwnerScopeService(store.serviceAuthority, f.runtime.ownerId!, Date.now).issue({
        id: 'coding-service',
        subject: {
          workspaceId: 'ws_ocean',
          roomId: f.room,
          botId: bot.id,
          projectId: hash(f.project),
          taskId: 'task',
        },
        permissions: [
          {
            kind: 'service',
            connectionId: c.id,
            trustRevision: 1,
            tools: { kind: 'exact', names: ['write'] },
            resources: [{ kind: 'connection', connectionId: c.id }],
          },
        ],
        limits: { maxCalls: 16, maxEffectBytes: 65536, expiresAt: null },
      });
      let rounds = 0;
      const alias = 'mcp_' + hash(JSON.stringify([c.id, 'write'])).slice(0, 56);
      const provider: ProviderPort = {
        id: 'fixture',
        models: ['fixture'],
        capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
        async *stream(request) {
          expect(request.tools?.map((t) => t.name)).toEqual(
            expect.arrayContaining(['read_file', alias]),
          );
          if (rounds === 1)
            expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('module.exports');
          if (rounds === 2)
            expect(JSON.stringify(request.messages.at(-1)?.content)).toContain('fixture');
          const call =
            rounds === 0
              ? { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' }
              : rounds === 1
                ? { id: 'service', name: alias, arguments: '{"value":"alpha"}' }
                : null;
          rounds++;
          if (call) yield { type: 'tool_call', call };
          else yield { type: 'text_delta', text: 'combined answer' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield {
            type: 'completed',
            stopReason: call ? 'tool_calls' : 'stop',
            rawStopReason: 'scripted',
          };
        },
      };
      const result = await f.send('combined', provider);
      expect(result).toMatchObject({
        ok: true,
        value: { status: 'completed', text: 'combined answer' },
      });
      expect([rounds, http.stats.calls, http.stats.effects]).toEqual([3, 1, 1]);
      expect(f.previews).toEqual([]);
      expect(await f.runtime.toolJournal!.pending()).toEqual([]);
    } finally {
      await f.runtime.services!.drain();
      store.close();
      await http.close();
      f.close();
    }
  },
  30000,
);
