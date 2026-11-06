import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ServiceTurnTools, type ServiceCallTransportPort } from '@runnets/application';
import { type ChatTurn, type ServiceCatalogSnapshot } from '@runnets/domain';
import { admission, connection, subject } from '../test-fixtures/admission.js';

it.each(['same', 'provenance', 'account', 'trust', 'key', 'grant'] as const)(
  'rebases only the full original selected definition and authority: %s',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'route-refresh-'));
    let effects = 0;
    const transport: ServiceCallTransportPort = {
      async invoke(input) {
        if (!input.authorizeDispatch()) throw Error('dispatch denied');
        effects++;
        return {
          kind: 'observed',
          invocationId: input.invocationId,
          code: 'ok',
          vendorErrorCode: null,
          result: { content: [] },
        };
      },
    };
    const c = connection({ kind: 'http', url: 'http://127.0.0.1/mcp' });
    const a = admission(join(dir, 'db'), c, transport);
    const first: ServiceCatalogSnapshot = {
      id: 'first',
      connectionId: c.id,
      configRevision: 1,
      trustRevision: 1,
      credentialRevision: 1,
      completeness: 'complete',
      observedAt: c.createdAt,
      provenance: { source: 'fixture' },
      tools: [
        {
          name: 'write',
          description: 'selected',
          inputSchema: { type: 'object' },
          outputSchema: null,
          annotations: null,
          definitionDigest: 'a'.repeat(64),
          provenance: { source: 'original' },
        },
      ],
    };
    try {
      expect(a.publish(first)).toBe(true);
      a.grant(['write']);
      const call = vi.fn(a.service.call.bind(a.service));
      const source = new ServiceTurnTools({
        store: a.authority,
        admission: { call },
        ownerId: 'owner',
        now: Date.now,
        restored: false,
        sha256: (s) => createHash('sha256').update(s).digest('hex'),
        subject: () => subject,
        ready: () => true,
      });
      const turn = {
        ...subject,
        id: 'turn',
        taskRunId: 'run',
        bot: { id: 'bot' },
      } as unknown as ChatTurn;
      const tools = (await source.forTurn(turn, new AbortController().signal))!;
      a.authority.atomic((tx) => {
        const old = tx.connection(c.id)!;
        const fresh = {
          ...old,
          configRevision: 2,
          ...(mode === 'account'
            ? {
                trust: {
                  ...old.trust,
                  identity: {
                    status: 'verified' as const,
                    accountId: 'other',
                    evidenceReference: 'synthetic',
                  },
                },
              }
            : {}),
          ...(['trust', 'account'].includes(mode) ? { trustRevision: 2 } : {}),
          ...(mode === 'key' ? { credentialRevision: 2, credentialReference: 'env:OTHER' } : {}),
        };
        expect(tx.putConnection(fresh, old)).toBe(true);
        const catalog = {
          ...first,
          id: 'fresh',
          configRevision: fresh.configRevision,
          trustRevision: fresh.trustRevision,
          credentialRevision: fresh.credentialRevision,
          tools:
            mode === 'provenance'
              ? first.tools.map((t) => ({
                  ...t,
                  provenance: { source: 'changed-only-provenance' },
                }))
              : first.tools,
        };
        expect(tx.putCatalog(catalog) && tx.publishCatalog(c.id, fresh, catalog.id)).toBe(true);
        if (mode === 'grant') {
          const g = tx.grant('grant')!;
          expect(tx.putGrant({ ...g, revision: 2 }, 1)).toBe(true);
        }
      });
      const result = await tools.execute(
        { id: 'selected', name: tools.definitions[0]!.name, arguments: '{}' },
        new AbortController().signal,
        { taskRunId: 'run', attemptId: 'at' },
      );
      expect(result.isError).toBe(mode !== 'same');
      expect(effects).toBe(mode === 'same' ? 1 : 0);
      if (mode === 'same') {
        expect(call.mock.calls[0]![0].catalogId).toBe('fresh');
        const db = new DatabaseSync(join(dir, 'db'));
        const records = db.prepare('SELECT * FROM tool_invocations_v2').all();
        db.close();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ outcome: 'completed' });
        expect(JSON.stringify(records[0])).toContain('fresh');
        expect(JSON.stringify(records[0])).not.toContain('first');
      } else if (mode !== 'grant') expect(call).not.toHaveBeenCalled();
    } finally {
      a.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
