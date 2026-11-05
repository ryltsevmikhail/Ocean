import type { DatabaseSync } from 'node:sqlite';
import type { ServiceAuthorityStorePort, ServiceAuthorityTransaction } from '@runnets/application';
import {
  validOwnerScopeGrant,
  validServiceCatalogSnapshot,
  validServiceConnection,
  validServiceConnectionVersions,
  type ServiceConnectionVersions,
} from '@runnets/domain';
import {
  authorityCanonical as canonical,
  readAuthorityCatalog as catalog,
  readAuthorityConnection as connection,
  readAuthorityGrant as grant,
} from './service-authority-rows.js';
import { withImmediateTransaction } from './transaction.js';
const versionsMatch = (a: ServiceConnectionVersions, b: ServiceConnectionVersions) =>
  a.configRevision === b.configRevision &&
  a.trustRevision === b.trustRevision &&
  a.credentialRevision === b.credentialRevision;
export class SqliteServiceAuthority implements ServiceAuthorityStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  atomic<T>(work: (tx: ServiceAuthorityTransaction) => T): T {
    let active = true;
    const guard = () => {
      if (!active) throw Error('service authority transaction closed');
    };
    const db = this.#db;
    const tx: ServiceAuthorityTransaction = {
      connection: (id) => {
        guard();
        return connection(db, id);
      },
      listConnections: () => {
        guard();
        return db
          .prepare('SELECT id FROM ocean_service_connections ORDER BY id')
          .all()
          .map((r) => connection(db, String(r['id']))!);
      },
      putConnection: (record, expected) => {
        guard();
        const old = connection(db, record.id);
        if (
          expected === null
            ? old !== null
            : !old || !validServiceConnectionVersions(expected) || !versionsMatch(old, expected)
        )
          return false;
        if (!validServiceConnection(record)) throw Error('invalid service connection');
        if (old === null) {
          if (
            !versionsMatch(record, {
              configRevision: 1,
              trustRevision: 1,
              credentialRevision: 1,
            }) ||
            record.currentCatalogId !== null
          )
            return false;
          db.prepare('INSERT INTO ocean_service_connections VALUES(?,?,?,?,?,?)').run(
            record.id,
            record.configRevision,
            record.trustRevision,
            record.credentialRevision,
            null,
            JSON.stringify(record),
          );
        } else {
          if (
            record.currentCatalogId !== old.currentCatalogId ||
            record.createdAt !== old.createdAt ||
            versionsMatch(record, old)
          )
            return false;
          if (
            (record.name !== old.name || record.state !== old.state) &&
            record.configRevision === old.configRevision
          )
            return false;
          for (const [axis, field] of [
            ['configRevision', 'configuration'],
            ['trustRevision', 'trust'],
            ['credentialRevision', 'credentialReference'],
          ] as const) {
            if (
              record[axis] < old[axis] ||
              (canonical(record[field]) !== canonical(old[field]) && record[axis] === old[axis])
            )
              return false;
          }
          db.prepare(
            'UPDATE ocean_service_connections SET config_revision=?,trust_revision=?,credential_revision=?,record=? WHERE id=?',
          ).run(
            record.configRevision,
            record.trustRevision,
            record.credentialRevision,
            JSON.stringify(record),
            record.id,
          );
        }
        return true;
      },
      catalog: (id) => {
        guard();
        return catalog(db, id);
      },
      putCatalog: (record) => {
        guard();
        if (!validServiceCatalogSnapshot(record)) throw Error('invalid service catalog');
        const old = catalog(db, record.id);
        if (old) {
          if (canonical(old) !== canonical(record))
            throw Error('service catalog immutable conflict');
          return true;
        }
        db.prepare('INSERT INTO ocean_service_catalogs VALUES(?,?,?)').run(
          record.id,
          record.connectionId,
          JSON.stringify(record),
        );
        return true;
      },
      publishCatalog: (id, expected, snapshotId) => {
        guard();
        if (!validServiceConnectionVersions(expected)) return false;
        const current = connection(db, id),
          snapshot = catalog(db, snapshotId);
        if (
          !current ||
          !snapshot ||
          snapshot.connectionId !== id ||
          !versionsMatch(current, expected) ||
          !versionsMatch(snapshot, expected)
        )
          return false;
        db.prepare(
          'UPDATE ocean_service_connections SET current_catalog_id=?,record=? WHERE id=?',
        ).run(snapshotId, JSON.stringify({ ...current, currentCatalogId: snapshotId }), id);
        return true;
      },
      grant: (id) => {
        guard();
        return grant(db, id);
      },
      listGrants: () => {
        guard();
        return db
          .prepare('SELECT id FROM ocean_owner_scope_grants ORDER BY id')
          .all()
          .map((r) => grant(db, String(r['id']))!);
      },
      putGrant: (record, expected) => {
        guard();
        const old = grant(db, record.id);
        if (expected === null ? old !== null : !old || old.revision !== expected) return false;
        if (!validOwnerScopeGrant(record)) throw Error('invalid owner scope grant');
        if (record.revision !== (expected === null ? 1 : expected + 1)) return false;
        if (old === null)
          db.prepare('INSERT INTO ocean_owner_scope_grants VALUES(?,?,?)').run(
            record.id,
            record.revision,
            JSON.stringify(record),
          );
        else
          db.prepare('UPDATE ocean_owner_scope_grants SET revision=?,record=? WHERE id=?').run(
            record.revision,
            JSON.stringify(record),
            record.id,
          );
        return true;
      },
    };
    try {
      return withImmediateTransaction(db, () => {
        const result = work(tx);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          'then' in result &&
          typeof result.then === 'function'
        ) {
          // Misuse is reported synchronously; observe the discarded async failure too.
          void Promise.resolve(result).catch(() => {});
          throw Error('service authority callback must be synchronous');
        }
        return result;
      });
    } finally {
      active = false;
    }
  }
}
