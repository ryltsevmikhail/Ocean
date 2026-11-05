import { expect, it } from 'vitest';
import {
  OwnerScopeService,
  beginServiceCatalogRefresh,
  publishServiceCatalogRefresh,
  type ServiceCallTransportPort,
} from '@runnets/application';
import { type OwnerPermission, type OwnerToolPolicy } from '@runnets/domain';
import { rig } from '../test-fixtures/service-call-rig.js';
import {
  authorityAt,
  serviceCatalog,
  serviceConnection,
} from '../../../test-fixtures/service-authority.js';
const invoke: ServiceCallTransportPort['invoke'] = async (r) => {
  if (!r.authorizeDispatch()) throw Error('denied');
  return {
    kind: 'observed',
    code: 'ok',
    result: true,
    invocationId: r.invocationId,
    vendorErrorCode: null,
  };
};
it.each(['exact', 'current-set', 'all-including-future'] as const)(
  'materializes %s without coupling the selected definitions to unrelated growth or SDK provenance',
  async (kind) => {
    const f = rig(invoke),
      original = serviceCatalog.tools[0]!;
    const policy: OwnerToolPolicy =
      kind === 'all-including-future'
        ? { kind, explicitlySelected: true }
        : { kind, names: [original.name] };
    const p: OwnerPermission = {
      kind: 'service',
      connectionId: 'third',
      trustRevision: 1,
      resources: [{ kind: 'connection', connectionId: 'third' }],
      tools: policy,
    };
    const grant = f.owners.revise(f.request.grantReference, { ...f.intent, permissions: [p] });
    const tools = [
      { ...original, provenance: { adapter: 'new-sdk' } },
      { ...original, name: 'different' },
    ];
    const publish = (id: string, defs: typeof serviceCatalog.tools) =>
      f.authority.atomic((tx) =>
        publishServiceCatalogRefresh(tx, { ...serviceCatalog, id, tools: defs }),
      );
    expect(publish('grown', tools)).toBe(true);
    const req = {
      ...f.request,
      catalogId: 'grown',
      grantReference: { grantId: grant.id, revision: grant.revision },
    };
    expect((await f.service.call(req)).outcome?.kind).toBe('observed');
    expect(
      (await f.service.call({ ...req, invocationId: 'new', tool: 'different' })).outcome?.kind,
    ).toBe(kind === 'all-including-future' ? 'observed' : undefined);
    expect(publish('changed', [{ ...original, outputSchema: { type: 'string' } }])).toBe(true);
    expect(
      (await f.service.call({ ...req, catalogId: 'changed', invocationId: 'change' })).outcome,
    ).toBeNull();
    expect(publish('restored', [original])).toBe(true);
    expect(
      (await f.service.call({ ...req, catalogId: 'restored', invocationId: 'restore' })).outcome
        ?.kind,
    ).toBe('observed');
    expect(publish('revised', [{ ...original, outputSchema: { type: 'string' } }])).toBe(true);
    expect(f.authority.atomic((tx) => tx.grant(grant.id))).toEqual(grant);
    const revised = f.owners.revise(req.grantReference, { ...f.intent, permissions: [p] });
    expect(
      (
        await f.service.call({
          ...req,
          catalogId: 'revised',
          invocationId: 'reissue',
          grantReference: { grantId: revised.id, revision: revised.revision },
        })
      ).outcome?.kind,
    ).toBe('observed');
  },
);
it('refuses inert exact grants, foreign owners, model-authored authority and unapproved room, task or project', async () => {
  const f = rig(invoke);
  expect(() =>
    new OwnerScopeService(f.authority, 'foreign', () => Date.parse(authorityAt)).revoke(
      f.request.grantReference,
    ),
  ).toThrow('grant_conflict');
  expect(() =>
    f.owners.issue({ ...f.intent, id: 'forged', owner: f.issued.owner } as typeof f.intent),
  ).toThrow('invalid_owner_intent');
  expect(() => f.owners.issue({ ...f.intent, mode: 'confirm' })).toThrow('grant_conflict');
  for (const changed of [
    { workspaceId: 'other' },
    { roomId: 'other' },
    { botId: 'other' },
    { taskId: 'other' },
    { projectId: 'other' },
  ])
    expect((await f.service.call({ ...f.request, ...changed })).outcome).toBeNull();
  f.authority.atomic((tx) =>
    tx.putGrant({ ...f.issued, id: 'inert', permissions: f.intent.permissions }, null),
  );
  expect(
    (await f.service.call({ ...f.request, grantReference: { grantId: 'inert', revision: 1 } }))
      .code,
  ).toBe('authority_denied');
  expect(
    (await f.service.call({ ...f.request, authority: f.issued } as typeof f.request)).code,
  ).toBe('invalid_request');
  const confirm = f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
  expect(
    (
      await f.service.call({
        ...f.request,
        grantReference: { grantId: 'grant', revision: confirm.revision },
      })
    ).code,
  ).toBe('confirmation_required');
  const expired = f.owners.revise(
    { grantId: 'grant', revision: 2 },
    { ...f.intent, limits: { ...f.intent.limits, expiresAt: authorityAt } },
  );
  expect(
    (
      await f.service.call({
        ...f.request,
        grantReference: { grantId: 'grant', revision: expired.revision },
      })
    ).outcome,
  ).toBeNull();
});
it('refuses failed or stale refresh and unproven credential continuity without rewriting the grant', async () => {
  let qualified = false;
  const f = rig(invoke, 2000, {
    credentialContinuous: (c, baseline) =>
      qualified && c.credentialRevision === 2 && baseline.credentialRevision === 1,
  });
  const refresh = f.authority.atomic((tx) => beginServiceCatalogRefresh(tx, 'third'));
  expect((await f.service.call(f.request)).code).toBe('catalog_stale');
  expect(f.authority.atomic((tx) => publishServiceCatalogRefresh(tx, serviceCatalog))).toBe(false);
  const fresh = { ...serviceCatalog, id: 'fresh', configRevision: refresh.configRevision };
  expect(f.authority.atomic((tx) => publishServiceCatalogRefresh(tx, fresh))).toBe(true);
  expect((await f.service.call({ ...f.request, catalogId: 'fresh' })).outcome?.kind).toBe(
    'observed',
  );
  f.authority.atomic((tx) => {
    const c = tx.connection('third')!;
    expect(tx.putConnection({ ...c, credentialRevision: 2 }, c)).toBe(true);
    expect(
      publishServiceCatalogRefresh(tx, { ...fresh, id: 'rotated', credentialRevision: 2 }),
    ).toBe(true);
  });
  const req = { ...f.request, catalogId: 'rotated', invocationId: 'rotated' };
  expect((await f.service.call(req)).code).toBe('authority_denied');
  qualified = true;
  expect((await f.service.call(req)).outcome?.kind).toBe('observed');
  f.authority.atomic((tx) => {
    const c = tx.connection('third')!,
      configuration = { kind: 'http' as const, url: 'https://other.example/' };
    expect(tx.putConnection({ ...c, configuration, configRevision: 3 }, c)).toBe(false);
    expect(
      tx.putConnection(
        {
          ...c,
          configuration,
          configRevision: 3,
          trustRevision: 2,
          trust: { ...c.trust, metadataPermission: 'none' },
        },
        c,
      ),
    ).toBe(true);
    expect(() => beginServiceCatalogRefresh(tx, 'third')).toThrow('metadata_permission_required');
    expect(
      publishServiceCatalogRefresh(tx, {
        ...fresh,
        id: 'forged',
        configRevision: 3,
        trustRevision: 2,
        credentialRevision: 2,
      }),
    ).toBe(false);
    expect(tx.grant('grant')).toEqual(f.issued);
  });
});
it('requires positive host classification and matching current account enforcement for narrow scopes', async () => {
  const f = rig(invoke),
    original = f.issued.permissions[0]!;
  if (original.kind !== 'service') throw Error('service fixture expected');
  const scope = {
    kind: 'github-repository' as const,
    repository: 'owner/repo',
    connectionId: 'third',
    accountId: 'account',
  };
  const grant = f.owners.revise(f.request.grantReference, {
    ...f.intent,
    permissions: [{ ...original, resources: [scope] }],
  });
  const req = {
    ...f.request,
    grantReference: { grantId: 'grant', revision: grant.revision },
    arguments: { repository: 'owner/repo', readOnlyHint: true },
  };
  expect((await f.service.call(req)).code).toBe('authority_denied');
  expect(f.journal.grantCalls('run', 'grant')).toBe(0);
  expect(serviceConnection.trust.identity.status).toBe('unverified');
});
it('requires owner review of a changed current set before issuing the baseline', () => {
  const f = rig(invoke),
    names = ['notes.search'];
  f.authority.atomic((tx) =>
    expect(
      publishServiceCatalogRefresh(tx, {
        ...serviceCatalog,
        id: 'larger',
        tools: [...serviceCatalog.tools, { ...serviceCatalog.tools[0]!, name: 'new' }],
      }),
    ).toBe(true),
  );
  const p = {
    kind: 'service' as const,
    connectionId: 'third',
    trustRevision: 1,
    resources: [{ kind: 'connection' as const, connectionId: 'third' }],
    tools: { kind: 'current-set' as const, names },
  };
  expect(() =>
    f.owners.revise(f.request.grantReference, { ...f.intent, permissions: [p] }),
  ).toThrow('catalog_stale');
  expect(f.authority.atomic((tx) => tx.grant('grant'))).toEqual(f.issued);
});
it('suspends only the changed name in a two-tool owner baseline', async () => {
  const f = rig(invoke),
    one = serviceCatalog.tools[0]!,
    two = { ...one, name: 'second' };
  f.authority.atomic((tx) =>
    expect(
      publishServiceCatalogRefresh(tx, { ...serviceCatalog, id: 'both', tools: [one, two] }),
    ).toBe(true),
  );
  const revision = f.owners.revise(f.request.grantReference, {
    ...f.intent,
    permissions: [
      {
        kind: 'service',
        connectionId: 'third',
        trustRevision: 1,
        resources: [{ kind: 'connection', connectionId: 'third' }],
        tools: { kind: 'exact', names: [one.name, two.name] },
      },
    ],
  });
  f.authority.atomic((tx) =>
    expect(
      publishServiceCatalogRefresh(tx, {
        ...serviceCatalog,
        id: 'delta',
        tools: [{ ...one, inputSchema: { type: 'null' } }, two],
      }),
    ).toBe(true),
  );
  const req = {
    ...f.request,
    catalogId: 'delta',
    grantReference: { grantId: 'grant', revision: revision.revision },
  };
  expect((await f.service.call(req)).code).toBe('authority_denied');
  expect((await f.service.call({ ...req, tool: 'second' })).outcome?.kind).toBe('observed');
});
