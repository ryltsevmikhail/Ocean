import {
  validOwnerScopeGrant,
  validOwnerPermission,
  type OwnerScopeGrant,
  type OwnerGrantReference,
  type OwnerPermission,
} from '@runnets/domain';
import type {
  ServiceAuthorityStorePort,
  ServiceAuthorityTransaction,
} from './service-authority-ports.js';
import { currentServiceCatalog } from './service-catalog-policy.js';
export type { OwnerScopeIntent } from '@runnets/domain';
import type { OwnerScopeIntent } from '@runnets/domain';
function materialize(
  tx: ServiceAuthorityTransaction,
  owner: string,
  p: OwnerPermission,
): OwnerPermission {
  if (!validOwnerPermission(p)) throw Error('invalid_owner_permission');
  if (p.kind === 'coding') return p;
  const c = tx.connection(p.connectionId);
  const s = c && currentServiceCatalog(tx, c);
  if (!c || !s || c.trust.ownerId !== owner || p.trustRevision !== c.trustRevision)
    throw Error('catalog_stale');
  if (p.baselineCatalogId !== undefined && p.baselineCatalogId !== s.id)
    throw Error('catalog_stale');
  const policy = p.tools;
  if (
    policy.kind === 'current-set' &&
    (policy.names.length !== s.tools.length || s.tools.some((t) => !policy.names.includes(t.name)))
  )
    throw Error('catalog_stale');
  const tools =
    policy.kind === 'current-set'
      ? { kind: policy.kind, names: s.tools.map((t) => t.name) }
      : policy;
  if (
    tools.kind !== 'all-including-future' &&
    tools.names.some((n) => !s.tools.some((t) => t.name === n))
  )
    throw Error('tool_unknown');
  return { ...p, tools, baselineCatalogId: s.id };
}
/** Runtime constructs this capability for the authenticated owner interface only. */
export class OwnerScopeService {
  private readonly store: ServiceAuthorityStorePort;
  private readonly ownerId: string;
  private readonly now: () => number;
  constructor(store: ServiceAuthorityStorePort, ownerId: string, now: () => number) {
    this.store = store;
    this.ownerId = ownerId;
    this.now = now;
  }
  issue(intent: OwnerScopeIntent, tx?: ServiceAuthorityTransaction): OwnerScopeGrant {
    return this.write(intent, null, tx);
  }
  revise(
    reference: OwnerGrantReference,
    intent: OwnerScopeIntent,
    tx?: ServiceAuthorityTransaction,
  ): OwnerScopeGrant {
    if (reference.grantId !== intent.id) throw Error('grant_conflict');
    return this.write(intent, reference.revision, tx);
  }
  revoke(ref: OwnerGrantReference, transaction?: ServiceAuthorityTransaction): OwnerScopeGrant {
    return this.transact((tx) => {
      const old = tx.grant(ref.grantId);
      if (
        !old ||
        old.owner.ownerId !== this.ownerId ||
        old.revision !== ref.revision ||
        old.state !== 'active'
      )
        throw Error('grant_conflict');
      const record = {
        ...old,
        state: 'revoked' as const,
        revision: old.revision + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      if (!tx.putGrant(record, old.revision)) throw Error('grant_conflict');
      return record;
    }, transaction);
  }
  private transact<T>(
    work: (tx: ServiceAuthorityTransaction) => T,
    tx?: ServiceAuthorityTransaction,
  ): T {
    return tx ? work(tx) : this.store.atomic(work);
  }
  private write(
    intent: OwnerScopeIntent,
    expected: number | null,
    transaction?: ServiceAuthorityTransaction,
  ): OwnerScopeGrant {
    if (
      (Object.hasOwn(intent, 'mode') &&
        intent.mode !== 'autonomous' &&
        intent.mode !== 'confirm') ||
      Object.keys(intent).some(
        (k) => !['id', 'subject', 'permissions', 'limits', 'mode'].includes(k),
      )
    )
      throw Error('invalid_owner_intent');
    return this.transact((tx) => {
      const old = tx.grant(intent.id);
      if (
        expected !== null &&
        (!old ||
          old.revision !== expected ||
          old.owner.ownerId !== this.ownerId ||
          old.state !== 'active')
      )
        throw Error('grant_conflict');
      const at = new Date(this.now()).toISOString();
      const grant: OwnerScopeGrant = {
        id: intent.id,
        subject: intent.subject,
        limits: intent.limits,
        mode: Object.hasOwn(intent, 'mode') ? intent.mode! : (old?.mode ?? 'autonomous'),
        permissions: intent.permissions.map((p) => materialize(tx, this.ownerId, p)),
        policyVersion: 2,
        state: 'active',
        revision: (expected ?? 0) + 1,
        owner: { ownerId: this.ownerId, source: 'owner-interface', issuedAt: at },
        updatedAt: at,
      };
      if (!validOwnerScopeGrant(grant) || !tx.participates(grant.subject))
        throw Error('invalid_owner_scope');
      if (!tx.putGrant(grant, expected)) throw Error('grant_conflict');
      return structuredClone(grant);
    }, transaction);
  }
}
