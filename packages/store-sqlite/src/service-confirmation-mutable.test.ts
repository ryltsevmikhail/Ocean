import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { rig } from '../test-fixtures/service-call-rig.js';
it('owns an immutable preview while an adapter mutates an otherwise allowed resource scope in place', async () => {
  const alpha = {
    kind: 'github-repository' as const,
    connectionId: 'third',
    accountId: 'acct',
    repository: 'org/alpha',
  };
  const beta = { ...alpha, repository: 'org/beta' };
  const scope = { kind: 'resources' as const, resources: [{ ...alpha }] };
  let sends = 0;
  const f = rig(
    async () => {
      sends++;
      throw Error('forbidden');
    },
    2000,
    {
      classify: () => ({
        scope,
        effectKind: 'mutation',
        githubRepositoryIds: { 'org/alpha': '1', 'org/beta': '2' },
      }),
      confirmation: {
        confirm: async (operation, _signal, current) => {
          expect(await current()).toBe(true);
          const preview = JSON.stringify(operation),
            digest = createHash('sha256').update(preview).digest('hex');
          expect(Object.isFrozen(scope.resources[0])).toBe(false);
          scope.resources[0]!.repository = 'org/beta';
          expect(operation.effect.scope).toEqual({ kind: 'resources', resources: [alpha] });
          expect(JSON.stringify(operation)).toBe(preview);
          expect(createHash('sha256').update(JSON.stringify(operation)).digest('hex')).toBe(digest);
          expect(await current()).toBe(false);
          return 'allowed';
        },
      },
    },
  );
  f.authority.atomic((tx) => {
    const c = tx.connection('third')!,
      s = tx.catalog('catalog')!;
    const next = {
      ...c,
      trustRevision: 2,
      trust: {
        ...c.trust,
        identity: {
          status: 'verified' as const,
          accountId: 'acct',
          evidenceReference: 'synthetic',
        },
        resourceEnforcement: [alpha, beta].map((resource) => ({
          status: 'evidenced' as const,
          scope: resource,
          evidenceReference: 'synthetic',
        })),
      },
    };
    expect(tx.putConnection(next, c)).toBe(true);
    expect(tx.putCatalog({ ...s, id: 'qualified', trustRevision: 2 })).toBe(true);
    expect(tx.publishCatalog(c.id, next, 'qualified')).toBe(true);
  });
  f.owners.revise(f.request.grantReference, {
    ...f.intent,
    mode: 'confirm',
    permissions: f.intent.permissions.map((p) => ({ ...p, trustRevision: 2 })),
  });
  expect(
    (
      await f.service.call({
        ...f.request,
        catalogId: 'qualified',
        grantReference: { grantId: 'grant', revision: 2 },
      })
    ).outcome,
  ).toBeNull();
  expect(f.journal.grantCalls('run', 'grant')).toBe(0);
  expect(sends).toBe(0);
});
