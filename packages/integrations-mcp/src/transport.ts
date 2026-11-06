import {
  canonicalJson,
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
    sessions.delete(s);
    if (active.get(s.connection.id) === s) active.delete(s.connection.id);
    return result;
  };
  async function discover(connection: ServiceConnection, opts: McpDiscoveryOptions) {
    if (
      closed ||
      unknown ||
      sessions.size >= 8 ||
      !validServiceConnection(connection) ||
      connection.state !== 'active' ||
      connection.trust.metadataPermission !== 'allow' ||
      !Number.isSafeInteger(opts.deadlineMs) ||
      opts.deadlineMs < 1
    )
      throw new ServicePluginDiscoveryRefusedError('execution_disabled', 'discovery unavailable');
    const deadlineMs = Math.min(opts.deadlineMs, SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS);
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(deadlineMs)]);
    const s = new Session(
      freezeJson(structuredClone(connection)),
      { ...opts, signal, deadlineMs },
      options,
    );
    sessions.add(s);
    s.onLoss = () => {
      void retire(s);
    };
    const work = (async () => {
      try {
        const candidate = await s.discover();
        if (closed || unknown) throw Error('closed');
        candidates.set(candidate, s);
        return candidate;
      } catch {
        await retire(s);
        throw new ServicePluginDiscoveryRefusedError(
          'catalog_incomplete',
          'no qualified complete catalog',
        );
      }
    })();
    pending.add(work);
    const joined = work.finally(() => pending.delete(work));
    if (connection.configuration.kind !== 'stdio') return joined;

    // A kernel file operation may not be interruptible. Release the caller at expiry,
    // but keep the session slot and close() join until that preflight actually unwinds.
    return new Promise<McpCatalogCandidate>((resolve, reject) => {
      const abort = () => {
        if (s.preparingStdio)
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
