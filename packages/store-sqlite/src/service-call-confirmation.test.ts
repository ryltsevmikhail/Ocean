import { createHash } from 'node:crypto';
import { canonicalJson } from '@runnets/domain';
import { expect, it } from 'vitest';
import { rig } from '../test-fixtures/service-call-rig.js';

it('waits for exact live confirmation before a coherent current-catalog claim', async () => {
  let sends = 0;
  const f = rig(
    async (input) => {
      expect(input.catalogId).toBe('refreshed');
      expect(input.connection).toMatchObject({ configRevision: 2, currentCatalogId: 'refreshed' });
      expect(f.journal.grantCalls('run', 'grant')).toBe(1);
      expect(input.authorizeDispatch()).toBe(true);
      sends++;
      return {
        kind: 'observed',
        code: 'ok',
        invocationId: input.invocationId,
        result: { accepted: true },
        vendorErrorCode: null,
      };
    },
    20,
    {
      classify: () => ({
        scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: 'third' }] },
        effectKind: 'mutation',
        githubRepositoryIds: { 'org/repo': '123' },
      }),
      confirmation: {
        confirm: async (operation, signal, current) => {
          expect(signal.aborted).toBe(false);
          expect(operation.request).not.toHaveProperty('catalogId');
          expect(operation.effect.binding).not.toHaveProperty('catalogId');
          expect(operation.effect.binding).not.toHaveProperty('configRevision');
          expect(operation.effect).toMatchObject({
            grantReference: { grantId: 'grant', revision: 2 },
            scope: {
              kind: 'resources',
              resources: [{ kind: 'connection', connectionId: 'third' }],
            },
            binding: {
              trustRevision: 1,
              credentialRevision: 1,
              githubRepositoryIds: { 'org/repo': '123' },
            },
          });
          expect(JSON.stringify(operation)).not.toContain('SERVICE_TOKEN');
          expect(Object.isFrozen(operation.definition.inputSchema)).toBe(true);
          expect(f.journal.grantCalls('run', 'grant')).toBe(0);
          await new Promise((resolve) => setTimeout(resolve, 30));
          f.authority.atomic((tx) => {
            const c = tx.connection('third')!,
              old = tx.catalog('catalog')!;
            expect(tx.putConnection({ ...c, configRevision: 2 }, c)).toBe(true);
            expect(tx.putCatalog({ ...old, id: 'refreshed', configRevision: 2 })).toBe(true);
            expect(tx.publishCatalog(c.id, { ...c, configRevision: 2 }, 'refreshed')).toBe(true);
          });
          expect(await current()).toBe(true);
          return 'allowed';
        },
      },
    },
  );
  f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
  const request = { ...f.request, grantReference: { grantId: 'grant', revision: 2 } };
  expect((await f.service.call(request)).outcome?.kind).toBe('observed');
  expect(sends).toBe(1);
  const row = f.db.prepare('SELECT * FROM tool_invocations_v2').get();
  const binding = {
    catalogId: 'refreshed',
    configRevision: 2,
    trustRevision: 1,
    credentialRevision: 1,
  };
  expect(JSON.parse(String(row?.['admission']))).toMatchObject({ binding });
  expect(row?.['fingerprint']).toBe(
    createHash('sha256')
      .update(
        canonicalJson([
          { ...request, catalogId: 'refreshed' },
          JSON.parse(String(row?.['admission'])),
        ]),
      )
      .digest('hex'),
  );
});
it.each(['absent', 'denied', 'expired', 'invalidated', 'cancelled', 'interrupted'] as const)(
  'creates no claim or send for %s confirmation',
  async (mode) => {
    let sends = 0,
      checks = 0;
    const f = rig(
      async () => {
        sends++;
        throw Error('forbidden');
      },
      2000,
      mode === 'absent'
        ? {}
        : {
            confirmation: {
              confirm: async (_op, _signal, current) => {
                checks++;
                expect(await current()).toBe(true);
                return mode;
              },
            },
          },
    );
    f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
    const result = await f.service.call({
      ...f.request,
      grantReference: { grantId: 'grant', revision: 2 },
    });
    expect(result).toEqual({
      code: mode === 'absent' ? 'confirmation_required' : 'confirmation_' + mode,
      outcome: null,
    });
    expect(checks).toBe(mode === 'absent' ? 0 : 1);
    expect(f.journal.grantCalls('run', 'grant')).toBe(0);
    expect(sends).toBe(0);
  },
);
it.each([
  'revoke',
  'limits',
  'definition',
  'provenance',
  'credential',
  'route',
  'trust',
  'scope',
  'resolved-ids',
  'abort',
] as const)('rechecks %s during the owner wait even when a port reports allowed', async (mode) => {
  let sends = 0,
    changedScope = false;
  const abort = new AbortController();
  const resolvedIds = { 'org/repo': '123' };
  const f = rig(
    async () => {
      sends++;
      throw Error('forbidden');
    },
    2000,
    {
      classify: () => ({
        githubRepositoryIds: resolvedIds,
        scope: { kind: 'legacy-global-unknown' },
        effectKind: changedScope ? 'observation' : 'mutation',
      }),
      confirmation: {
        confirm: async (operation, _signal, current) => {
          const preview = JSON.stringify(operation);
          expect(Object.isFrozen(resolvedIds)).toBe(false);
          expect(await current()).toBe(true);
          if (mode === 'revoke') f.owners.revoke({ grantId: 'grant', revision: 2 });
          else if (mode === 'limits')
            f.owners.revise(
              { grantId: 'grant', revision: 2 },
              { ...f.intent, limits: { ...f.intent.limits, maxEffectBytes: 1 } },
            );
          else if (mode === 'abort') abort.abort();
          else if (mode === 'scope') changedScope = true;
          else if (mode === 'resolved-ids') resolvedIds['org/repo'] = '456';
          else
            f.authority.atomic((tx) => {
              const c = tx.connection('third')!,
                s = tx.catalog('catalog')!,
                tool = s.tools[0]!;
              const next = {
                ...c,
                configRevision: c.configRevision + 1,
                ...(mode === 'credential' ? { credentialRevision: 2 } : {}),
                ...(['trust', 'route'].includes(mode) ? { trustRevision: 2 } : {}),
                ...(mode === 'route'
                  ? { configuration: { kind: 'http' as const, url: 'https://changed.example/mcp' } }
                  : {}),
              };
              expect(tx.putConnection(next, c)).toBe(true);
              expect(
                tx.putCatalog({
                  ...s,
                  id: 'next',
                  configRevision: next.configRevision,
                  trustRevision: next.trustRevision,
                  credentialRevision: next.credentialRevision,
                  tools: [
                    {
                      ...tool,
                      ...(mode === 'definition' ? { description: 'changed' } : {}),
                      ...(mode === 'provenance' ? { provenance: { source: 'changed' } } : {}),
                    },
                  ],
                }),
              ).toBe(true);
              expect(tx.publishCatalog(c.id, next, 'next')).toBe(true);
            });
          expect(JSON.stringify(operation)).toBe(preview);
          expect(await current()).toBe(false);
          return 'allowed';
        },
      },
    },
  );
  f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
  expect(
    (
      await f.service.call(
        { ...f.request, grantReference: { grantId: 'grant', revision: 2 } },
        abort.signal,
      )
    ).outcome,
  ).toBeNull();
  expect(f.journal.grantCalls('run', 'grant')).toBe(0);
  expect(sends).toBe(0);
});
it.each(['revoke', 'provenance', 'refresh'] as const)(
  'retains the final postclaim send guard for %s',
  async (mode) => {
    let sends = 0;
    const f = rig(
      async (input) => {
        if (mode === 'revoke') f.owners.revoke({ grantId: 'grant', revision: 2 });
        else
          f.authority.atomic((tx) => {
            const c = tx.connection('third')!,
              s = tx.catalog('catalog')!;
            const next = { ...c, configRevision: c.configRevision + 1 };
            expect(tx.putConnection(next, c)).toBe(true);
            expect(
              tx.putCatalog({
                ...s,
                id: 'next',
                configRevision: next.configRevision,
                tools: s.tools.map((t) => ({
                  ...t,
                  ...(mode === 'provenance' ? { provenance: { source: 'other' } } : {}),
                })),
              }),
            ).toBe(true);
            expect(tx.publishCatalog(c.id, next, 'next')).toBe(true);
          });
        if (input.authorizeDispatch()) sends++;
        throw Error('refused');
      },
      2000,
      { confirmation: { confirm: async () => 'allowed' } },
    );
    f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
    expect(
      (await f.service.call({ ...f.request, grantReference: { grantId: 'grant', revision: 2 } }))
        .outcome?.kind,
    ).toBe('not_started');
    expect(f.journal.grantCalls('run', 'grant')).toBe(1);
    expect(sends).toBe(0);
  },
);

it('model-provided confirmation flags create no owner decision or business claim', async () => {
  let confirmations = 0;
  const f = rig(
    async () => {
      throw Error('forbidden');
    },
    2000,
    {
      confirmation: {
        confirm: async () => {
          confirmations++;
          return 'allowed';
        },
      },
    },
  );
  f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
  for (const flag of ['allowed', 'confirmation', 'owner', 'permit'])
    expect(
      await f.service.call({
        ...f.request,
        grantReference: { grantId: 'grant', revision: 2 },
        [flag]: true,
      }),
    ).toEqual({ code: 'invalid_request', outcome: null });
  expect(confirmations).toBe(0);
  expect(f.journal.grantCalls('run', 'grant')).toBe(0);
});
