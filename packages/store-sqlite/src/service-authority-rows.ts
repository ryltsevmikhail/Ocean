import type { DatabaseSync } from 'node:sqlite';
import {
  validOwnerScopeGrant,
  validServiceCatalogSnapshot,
  validServiceConnection,
  type OwnerScopeGrant,
  type ServiceCatalogSnapshot,
  type ServiceConnection,
} from '@runnets/domain';
export function readAuthorityConnection(db: DatabaseSync, id: string): ServiceConnection | null {
  const row = db.prepare('SELECT * FROM ocean_service_connections WHERE id=?').get(id);
  if (!row) return null;
  const value: unknown = JSON.parse(String(row['record']));
  if (
    !validServiceConnection(value) ||
    value.id !== row['id'] ||
    value.configRevision !== row['config_revision'] ||
    value.trustRevision !== row['trust_revision'] ||
    value.credentialRevision !== row['credential_revision'] ||
    value.currentCatalogId !== row['current_catalog_id']
  )
    throw Error('invalid service connection storage');
  return value;
}
export function readAuthorityCatalog(db: DatabaseSync, id: string): ServiceCatalogSnapshot | null {
  const row = db.prepare('SELECT * FROM ocean_service_catalogs WHERE id=?').get(id);
  if (!row) return null;
  const value: unknown = JSON.parse(String(row['record']));
  if (
    !validServiceCatalogSnapshot(value) ||
    value.id !== row['id'] ||
    value.connectionId !== row['connection_id']
  )
    throw Error('invalid service catalog storage');
  return value;
}
export function readAuthorityGrant(db: DatabaseSync, id: string): OwnerScopeGrant | null {
  const row = db.prepare('SELECT * FROM ocean_owner_scope_grants WHERE id=?').get(id);
  if (!row) return null;
  const value: unknown = JSON.parse(String(row['record']));
  if (!validOwnerScopeGrant(value) || value.id !== row['id'] || value.revision !== row['revision'])
    throw Error('invalid owner grant storage');
  return value;
}
/** Stable comparison ignores object insertion order; arrays retain policy order. */
export function authorityCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(authorityCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + authorityCanonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** No-argument callers retain complete core enumeration; owner views bound SQL first. */
export function authorityMetadataIds(
  db: DatabaseSync,
  table: 'ocean_service_connections' | 'ocean_owner_scope_grants',
  query?: { readonly ownerId: string; readonly limit: number },
) {
  if (
    query &&
    (!query.ownerId || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
  )
    throw Error('invalid_params');
  const owner = table === 'ocean_service_connections' ? '$.trust.ownerId' : '$.owner.ownerId';
  return query
    ? db
        .prepare(
          `SELECT id FROM ${table} WHERE json_extract(record, '${owner}')=? ORDER BY id LIMIT ?`,
        )
        .all(query.ownerId, query.limit)
    : db.prepare(`SELECT id FROM ${table} ORDER BY id`).all();
}
