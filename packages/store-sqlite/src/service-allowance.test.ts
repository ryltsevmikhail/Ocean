import { expect, it } from 'vitest';
import {
  ServiceCallAdmissionService,
  OwnerScopeService,
  type ServiceCallTransportPort,
} from '@runnets/application';
import { authorityAt } from '../../../test-fixtures/service-authority.js';
import { rig } from '../test-fixtures/service-call-rig.js';
import { openSqliteStore } from './store.js';
import { openDatabase, DEFAULT_BUSY_TIMEOUT_MS } from './schema.js';
import { SqliteServiceAuthority } from './service-authority-storage.js';
const now = () => Date.parse(authorityAt);
it('counts accepted claims across credential and grant revisions, refusing a competing claim and oversized bytes', async () => {
  let release!: () => void,
    entered!: () => void,
    sends = 0;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const f = rig(
    async (i) => {
      entered();
      await gate;
      if (!i.authorizeDispatch()) throw Error('denied');
      sends++;
      return {
        kind: 'observed',
        code: 'ok',
        result: true,
        invocationId: i.invocationId,
        vendorErrorCode: null,
      };
    },
    2000,
    {},
    true,
  );
  const second = openDatabase(f.path, DEFAULT_BUSY_TIMEOUT_MS);
  try {
    const authority = new SqliteServiceAuthority(second);
    const sibling = new ServiceCallAdmissionService({
      restored: false,
      store: authority,
      now,
      transport: {
        invoke: async () => {
          throw Error('unexpected invoke');
        },
      },
    });
    const intent = { ...f.intent, limits: { ...f.intent.limits, maxCalls: 1, maxEffectBytes: 64 } };
    f.owners.revise(f.request.grantReference, intent);
    const req = { ...f.request, grantReference: { grantId: 'grant', revision: 2 } };
    expect((await sibling.call({ ...req, arguments: { long: 'Ж'.repeat(32) } })).code).toBe(
      'grant_limit',
    );
    const first = f.service.call(req);
    await ready;
    expect(authority.atomic((tx) => tx.pending()[0])).toMatchObject({
      admission: { grantReference: req.grantReference },
      outcome: 'started',
    });
    expect((await sibling.call({ ...req, invocationId: 'race' })).code).toBe('grant_limit');
    release();
    expect((await first).outcome?.kind).toBe('observed');
    expect(sends).toBe(1);
    authority.atomic((tx) => {
      const c = tx.connection('third')!,
        catalog = tx.catalog('catalog')!;
      expect(tx.putConnection({ ...c, credentialRevision: 2 }, c)).toBe(true);
      expect(tx.putCatalog({ ...catalog, id: 'rotated', credentialRevision: 2 })).toBe(true);
      expect(tx.publishCatalog(c.id, { ...c, credentialRevision: 2 }, 'rotated')).toBe(true);
    });
    const updated = new OwnerScopeService(authority, 'owner', now).revise(
      req.grantReference,
      intent,
    );
    expect(
      (
        await sibling.call({
          ...req,
          invocationId: 'new',
          catalogId: 'rotated',
          grantReference: { grantId: 'grant', revision: updated.revision },
        })
      ).code,
    ).toBe('grant_limit');
  } finally {
    release();
    second.close();
  }
});
it('retains authority and original spent/lost claims after a transport loss and disk reopen', async () => {
  let sends = 0;
  const invoke: ServiceCallTransportPort['invoke'] = async (i) => {
    if (!i.authorizeDispatch()) throw Error('not started');
    sends++;
    throw Error('response dropped');
  };
  const f = rig(invoke, 2000, {}, true);
  expect((await f.service.call(f.request)).outcome?.kind).toBe('uncertain');
  f.db.close();
  const reopened = openSqliteStore({ path: f.path });
  try {
    const second = new ServiceCallAdmissionService({
      restored: false,
      store: reopened.serviceAuthority,
      now,
      transport: { invoke },
    });
    expect(reopened.serviceAuthority.atomic((tx) => tx.grant('grant'))).toEqual(f.issued);
    expect((await second.call(f.request)).code).toBe('claim_refused');
    expect((await second.call({ ...f.request, invocationId: 'new-id' })).code).toBe(
      'claim_refused',
    );
    expect(reopened.tools.inspectPending?.()[0]).toMatchObject({
      outcome: 'uncertain',
      admission: { scope: { kind: 'legacy-global-unknown' } },
    });
    expect(sends).toBe(1);
  } finally {
    reopened.close();
  }
});
