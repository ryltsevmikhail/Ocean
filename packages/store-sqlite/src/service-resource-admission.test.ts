import { expect, it } from 'vitest';
import { publishServiceCatalogRefresh } from '@runnets/application';
import { serviceCatalog } from '../../../test-fixtures/service-authority.js';
import { rig } from '../test-fixtures/service-call-rig.js';
it('blocks overlapping service mutations yet permits independent qualified resources and trusted reconnaissance', async () => {
  const repo = (repository: string) => ({
    kind: 'github-repository' as const,
    connectionId: 'third',
    accountId: 'acct',
    repository,
  });
  const alpha = repo('org/alpha'),
    beta = repo('org/beta');
  let sends = 0;
  const f = rig(
    async (i) => {
      if (!i.authorizeDispatch()) throw Error('denied');
      sends++;
      if (i.invocationId === 'lost') throw Error('lost');
      return {
        kind: 'observed',
        code: 'ok',
        result: true,
        invocationId: i.invocationId,
        vendorErrorCode: null,
      };
    },
    2000,
    {
      classify: (_c, t) => ({
        githubRepositoryIds: { 'org/alpha': '1', 'org/beta': '2' },
        effectKind: t.name === 'read-alpha' ? 'observation' : 'mutation',
        scope: { kind: 'resources', resources: [t.name === 'write-beta' ? beta : alpha] },
      }),
    },
  );
  f.authority.atomic((tx) => {
    const c = tx.connection('third')!;
    expect(
      tx.putConnection(
        {
          ...c,
          trustRevision: 2,
          trust: {
            ...c.trust,
            identity: { status: 'verified', accountId: 'acct', evidenceReference: 'host-fixture' },
            resourceEnforcement: [alpha, beta].map((scope) => ({
              status: 'evidenced',
              scope,
              evidenceReference: 'host-fixture',
            })),
          },
        },
        c,
      ),
    ).toBe(true);
    expect(
      publishServiceCatalogRefresh(tx, {
        ...serviceCatalog,
        id: 'v2',
        trustRevision: 2,
        tools: ['write-alpha', 'write-beta', 'read-alpha'].map((name) => ({
          ...serviceCatalog.tools[0]!,
          name,
        })),
      }),
    ).toBe(true);
  });
  const grant = f.owners.revise(f.request.grantReference, {
    ...f.intent,
    permissions: [
      {
        kind: 'service',
        connectionId: 'third',
        trustRevision: 2,
        resources: [alpha, beta],
        tools: { kind: 'current-set', names: ['write-alpha', 'write-beta', 'read-alpha'] },
      },
    ],
  });
  const call = (tool: string, id: string) =>
    f.service.call({
      ...f.request,
      catalogId: 'v2',
      tool,
      invocationId: id,
      grantReference: { grantId: 'grant', revision: grant.revision },
    });
  expect((await call('write-alpha', 'lost')).outcome?.kind).toBe('uncertain');
  expect((await call('write-alpha', 'overlap')).code).toBe('claim_refused');
  expect((await call('write-beta', 'independent')).outcome?.kind).toBe('observed');
  expect((await call('read-alpha', 'recon')).outcome?.kind).toBe('observed');
  expect(sends).toBe(3);
  expect(f.journal.inspectPending().map((r) => r.id)).toEqual(['lost']);
  // The real durable loss is still held after the reconciliation read.
  expect((await call('write-alpha', 'again')).code).toBe('claim_refused');
});
