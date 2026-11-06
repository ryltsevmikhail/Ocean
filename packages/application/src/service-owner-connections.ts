import {
  canonicalJson,
  type ServiceConnection,
  type ServiceConnectionVersions,
  type ServiceConnectionSetRequest,
} from '@runnets/domain';
import type { ServiceAuthorityTransaction } from './service-authority-ports.js';
export function ownedConnection(
  tx: ServiceAuthorityTransaction,
  ownerId: string,
  id: string,
  expected: ServiceConnectionVersions | null,
): ServiceConnection | null {
  const old = tx.connection(id);
  if (
    (old && old.trust.ownerId !== ownerId) ||
    (expected === null
      ? old !== null
      : !old ||
        ['configRevision', 'trustRevision', 'credentialRevision'].some(
          (axis) =>
            old[axis as keyof ServiceConnectionVersions] !==
            expected[axis as keyof ServiceConnectionVersions],
        ))
  )
    throw Error('connection_conflict');
  return old;
}
export function ownerConnectionRecord(
  old: ServiceConnection | null,
  request: ServiceConnectionSetRequest,
  ownerId: string,
  at: string,
  credentialReference: string | null,
  credentialBinding: string | undefined,
): ServiceConnection {
  const changedCredential =
    old &&
    (credentialReference !== old.credentialReference ||
      credentialBinding !== old.credentialBinding);
  const changedTrust =
    old &&
    (canonicalJson(old.configuration) !== canonicalJson(request.configuration) ||
      old.trust.metadataPermission !== request.metadataPermission ||
      changedCredential ||
      old.state !== 'active');
  return {
    id: request.connectionId,
    name: request.name,
    configuration: request.configuration,
    configRevision: (old?.configRevision ?? 0) + 1,
    trustRevision: (old?.trustRevision ?? 0) + (old && !changedTrust ? 0 : 1),
    credentialRevision: (old?.credentialRevision ?? 0) + (old && !changedCredential ? 0 : 1),
    credentialReference,
    ...(credentialBinding === undefined ? {} : { credentialBinding }),
    trust:
      old && !changedTrust
        ? old.trust
        : {
            ownerId,
            metadataPermission: request.metadataPermission,
            identity: { status: 'unverified', label: null },
            resourceEnforcement: [],
          },
    state: 'active',
    currentCatalogId: old?.currentCatalogId ?? null,
    createdAt: old?.createdAt ?? at,
    updatedAt: at,
  };
}
