import { ServiceCallAdmissionService } from '@runnets/application';
import { authorityAt } from '../../../test-fixtures/service-authority.js';
import { it, expect } from 'vitest';
import { rig } from '../test-fixtures/service-call-rig.js';
it('materializes the owner baseline, checks membership, commits once and never replays', async () => {
  let sends = 0;
  const f = rig(async (input) => {
    expect(input.authorizeDispatch()).toBe(true);
    sends++;
    expect(input.authorizeDispatch()).toBe(false);
    return {
      kind: 'observed',
      code: 'ok',
      invocationId: input.invocationId,
      result: true,
      vendorErrorCode: null,
    };
  });
  expect(f.issued.permissions[0]).toMatchObject({ baselineCatalogId: 'catalog' });
  expect((await f.service.call({ ...f.request, roomId: 'other' })).outcome).toBeNull();
  expect((await f.service.call(f.request)).outcome?.kind).toBe('observed');
  expect((await f.service.call({ ...f.request, arguments: { changed: true } })).outcome).toBeNull();
  expect(sends).toBe(1);
});
it.each(['revoke', 'abort', 'deadline', 'drop'] as const)(
  'guards suspended dispatch on %s',
  async (mode) => {
    let sends = 0,
      release!: () => void,
      entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    const f = rig(
      async (input) => {
        entered();
        await gate;
        if (input.authorizeDispatch()) sends++;
        throw Error('lost');
      },
      mode === 'deadline' ? 20 : 2000,
    );
    const c = new AbortController(),
      call = f.service.call(f.request, c.signal);
    await ready;
    if (mode === 'revoke') f.owners.revoke(f.request.grantReference);
    if (mode === 'abort') c.abort();
    if (mode !== 'deadline') release();
    expect((await call).outcome?.kind).toBe(mode === 'drop' ? 'uncertain' : 'not_started');
    release();
    await Promise.resolve();
    expect(sends).toBe(mode === 'drop' ? 1 : 0);
    expect((await f.service.call(f.request)).outcome).toBeNull();
  },
);
it.each(['unrelated', 'changed', 'credential'] as const)(
  'keeps a frozen call on its approved definition and route during %s churn',
  async (mode) => {
    let sends = 0;
    const f = rig(async (input) => {
      expect(Object.isFrozen(input.connection)).toBe(true);
      expect(Object.isFrozen(input.definition.inputSchema)).toBe(true);
      f.authority.atomic((tx) => {
        const c = tx.connection('third')!,
          s = tx.catalog('catalog')!,
          original = s.tools[0]!;
        const versions = mode === 'credential' ? { ...c, credentialRevision: 2 } : c;
        if (mode === 'credential') expect(tx.putConnection(versions, c)).toBe(true);
        const next = {
          ...s,
          id: 'alternate',
          credentialRevision: versions.credentialRevision,
          tools:
            mode === 'changed'
              ? [{ ...original, description: 'changed' }]
              : [original, { ...original, name: 'growth' }],
        };
        expect(tx.putCatalog(next)).toBe(true);
        expect(tx.publishCatalog(c.id, versions, next.id)).toBe(true);
      });
      expect(input.catalogId).toBe('catalog');
      if (!input.authorizeDispatch()) throw Error('refused');
      sends++;
      return {
        kind: 'observed',
        code: 'ok',
        invocationId: input.invocationId,
        result: true,
        vendorErrorCode: null,
      };
    });
    expect((await f.service.call(f.request)).outcome?.kind).toBe(
      mode === 'unrelated' ? 'observed' : 'not_started',
    );
    expect(sends).toBe(mode === 'unrelated' ? 1 : 0);
  },
);
it('closes restored admission even with a current owner grant', async () => {
  const f = rig(async () => {
    throw Error('must not invoke');
  });
  const s = new ServiceCallAdmissionService({
    store: f.authority,
    transport: {
      invoke: async () => {
        throw Error('must not invoke');
      },
    },
    restored: true,
    now: () => Date.parse(authorityAt),
  });
  expect((await s.call(f.request)).code).toBe('recovery_required');
  expect(f.journal.grantCalls('run', 'grant')).toBe(0);
});
it('holds a contradictory adapter observation without guard evidence as uncertain', async () => {
  const f = rig(async (input) => ({
    kind: 'observed',
    invocationId: input.invocationId,
    code: 'ok',
    result: true,
    vendorErrorCode: null,
  }));
  expect((await f.service.call(f.request)).outcome?.kind).toBe('uncertain');
  expect((await f.service.call({ ...f.request, invocationId: 'other' })).code).toBe(
    'claim_refused',
  );
});
