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
  const state = request.removeKey === true && old ? old.state : 'active';
  const changedTrust =
    old &&
    (canonicalJson(old.configuration) !== canonicalJson(request.configuration) ||
      old.trust.metadataPermission !== request.metadataPermission ||
      changedCredential ||
      old.state !== state);
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
    state,
    currentCatalogId: old?.currentCatalogId ?? null,
    createdAt: old?.createdAt ?? at,
    updatedAt: at,
  };
}

/** Retaining a bearer is safe only for the same HTTP origin, never a different transport. */
export function assertCredentialDestination(
  old: ServiceConnection | null,
  request: ServiceConnectionSetRequest,
): void {
  if (!old?.credentialReference) return;
  if (request.configuration.kind === 'stdio') throw Error('invalid_params');
  const compatible =
    old.configuration.kind === 'http' &&
    new URL(old.configuration.url).origin === new URL(request.configuration.url).origin;
  if (!compatible && request.key === undefined && request.removeKey !== true)
    throw Error('invalid_params');
}
