import {
  canonicalJson,
  managedEnrollment,
  validServiceConnection,
  validServiceCatalogSnapshot,
  type ServiceConnection,
} from '@runnets/domain';
import {
  SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS,
  ServicePluginDiscoveryRefusedError,
} from '@runnets/application';
import { freezeJson } from './catalog.js';
import type {
  McpServiceTransportOptions,
  McpServiceTransport,
  McpCatalogCandidate,
  McpCleanupEvidence,
  McpDiscoveryOptions,
} from './contracts.js';
import { Session } from './session.js';

export function createMcpServiceTransport(
  options: McpServiceTransportOptions,
): McpServiceTransport {
  const sessions = new Set<Session>();
  const replacing = new Set<Session>();
  const candidates = new WeakMap<McpCatalogCandidate, Session>();
  const active = new Map<string, Session>();
  const pending = new Set<Promise<unknown>>();
  let closed = false,
    unknown = false,
    started = false;
  const retire = async (s: Session) => {
    const result = await s.retire().catch(() => ({ status: 'unknown' }) as const);
    if (result.status === 'unknown' && !unknown) {
      unknown = true;
      for (const session of sessions) session.stop.abort();
    }
    if (result.status !== 'never_started') started = true;
    if (!replacing.has(s)) sessions.delete(s);
    if (active.get(s.connection.id) === s) active.delete(s.connection.id);
    return result;
  };
  async function discover(connection: ServiceConnection, opts: McpDiscoveryOptions) {
    if (
      closed ||
      unknown ||
      !validServiceConnection(connection) ||
      connection.state !== 'active' ||
      connection.trust.metadataPermission !== 'allow' ||
      !Number.isSafeInteger(opts.deadlineMs) ||
      opts.deadlineMs < 1
    )
      throw new ServicePluginDiscoveryRefusedError('execution_disabled', 'discovery unavailable');
    const previous =
      connection.configuration.kind === 'stdio' || sessions.size >= 8
        ? [...sessions].filter((old) => old.connection.id === connection.id)
        : [];
    const reuse = sessions.size >= 8 ? previous.find((old) => !replacing.has(old)) : undefined;
    if ((sessions.size >= 8 && !reuse) || previous.some((old) => replacing.has(old)))
      throw new ServicePluginDiscoveryRefusedError('execution_disabled', 'discovery unavailable');
    if (reuse) replacing.add(reuse);
    const deadlineMs = Math.min(opts.deadlineMs, SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS);
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(deadlineMs)]);
    const create = () => {
      const next = new Session(
        freezeJson(structuredClone(connection)),
        { ...opts, signal, deadlineMs },
        {
          ...options,
          refreshNeeded: (id) => {
            if (!closed && !unknown) options.refreshNeeded?.(id);
          },
        },
      );
      sessions.add(next);
      next.onLoss = () => {
        void retire(next);
      };
      return next;
    };
    let s = reuse ? undefined : create();
    const work = (async () => {
      try {
        if (connection.configuration.kind === 'stdio' || reuse) {
          for (const old of previous) {
            old.deactivate();
            active.delete(connection.id);
            await old.afterCalls();
            await retire(old);
          }
          if (closed || unknown || signal.aborted || s?.stop.signal.aborted)
            throw Error('retired before launch');
          if (reuse) {
            sessions.delete(reuse);
            replacing.delete(reuse);
            s = create();
          }
        }
        if (!s) throw Error('session unavailable');
        const candidate = await s.discover();
        if (closed || unknown) throw Error('closed');
        candidates.set(candidate, s);
        return candidate;
      } catch {
        if (s) await retire(s);
        throw new ServicePluginDiscoveryRefusedError(
          'catalog_incomplete',
          'no qualified complete catalog',
        );
      } finally {
        if (reuse) {
          replacing.delete(reuse);
          sessions.delete(reuse);
        }
      }
    })();
    pending.add(work);
    const joined = work.finally(() => pending.delete(work));
    if (connection.configuration.kind !== 'stdio' && !reuse) return joined;

    // A kernel file operation may not be interruptible. Release the caller at expiry,
    // but keep the session slot and close() join until that preflight actually unwinds.
    return new Promise<McpCatalogCandidate>((resolve, reject) => {
      const abort = () => {
        if (!s || s.preparingStdio)
          reject(
            new ServicePluginDiscoveryRefusedError(
              'catalog_incomplete',
              'native preflight interrupted',
            ),
          );
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void joined.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  return {
    discover,
    managed(connection) {
      const s = active.get(connection.id);
      return s &&
        !closed &&
        !unknown &&
        s.writer.usable &&
        !s.stop.signal.aborted &&
        s.published === connection.currentCatalogId &&
        managedEnrollment(s.connection) === managedEnrollment(connection) &&
        s.managed
        ? s.managed
        : null;
    },
    ready(connection, catalog) {
      const s = active.get(connection.id);
      return (
        !!s &&
        !closed &&
        !unknown &&
        s.writer.usable &&
        !s.stop.signal.aborted &&
        s.published === catalog.id &&
        connection.currentCatalogId === catalog.id &&
        connection.state === 'active' &&
        catalog.connectionId === connection.id &&
        catalog.configRevision === connection.configRevision &&
        catalog.trustRevision === connection.trustRevision &&
        catalog.credentialRevision === connection.credentialRevision &&
        canonicalJson(s.connection.configuration) === canonicalJson(connection.configuration) &&
        s.connection.configRevision === connection.configRevision &&
        s.connection.trustRevision === connection.trustRevision &&
        s.connection.credentialRevision === connection.credentialRevision &&
        canonicalJson({ ...s.catalog?.candidate, id: catalog.id }) === canonicalJson(catalog)
      );
    },
    activate(candidate, snapshot, confirmPublished) {
      const s = candidates.get(candidate);
      if (
        !s ||
        !sessions.has(s) ||
        closed ||
        unknown ||
        !s.writer.usable ||
        s.wasPublished ||
        !validServiceCatalogSnapshot(snapshot) ||
        canonicalJson(snapshot) !== canonicalJson({ ...candidate, id: snapshot.id })
      )
        return false;
      try {
        if (!confirmPublished()) return false;
      } catch {
        return false;
      }
      const old = active.get(candidate.connectionId);
      active.set(candidate.connectionId, s);
      s.activate(snapshot.id);
      if (old) {
        old.deactivate();
        void old.afterCalls().then(() => retire(old));
      }
      return true;
    },
    async disposeCandidate(candidate) {
      const s = candidates.get(candidate);
      return s ? retire(s) : { status: 'never_started' };
    },
    async invoke(input) {
      const s = active.get(input.connection.id);
      if (closed || unknown || !s)
        return {
          kind: 'not_started',
          code: 'catalog_unavailable',
          invocationId: input.invocationId,
          detail: 'no active catalog',
        };
      const work = s.invoke(input);
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    async retireUncertain(connection, generation) {
      if (!generation) return;
      const s = [...sessions].find(
        (candidate) =>
          candidate.connection.id === connection.id &&
          candidate.managed?.lifetime.record.fingerprint === generation &&
          managedEnrollment(candidate.connection) === managedEnrollment(connection),
      );
      if (!s || s.connection.configuration.kind !== 'stdio') return;
      if (active.get(connection.id) === s) active.delete(connection.id);
      s.markUncertain();
      await retire(s);
    },
    disconnect(id) {
      const s = active.get(id);
      if (!s) return;
      active.delete(id);
      s.deactivate();
      const work = s.afterCalls().then(() => retire(s));
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
    async close(): Promise<McpCleanupEvidence> {
      closed = true;
      for (const s of sessions) s.stop.abort();
      await Promise.allSettled([...pending]);
      await Promise.all([...sessions].map(retire));
      return { status: unknown ? 'unknown' : started ? 'confirmed' : 'never_started' };
    },
  };
}
