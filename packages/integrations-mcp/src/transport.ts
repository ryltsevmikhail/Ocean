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
    if (result.status === 'unknown') unknown = true;
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
  }
  return {
    discover(c, d) {
      const p = discover(c, d);
      pending.add(p);
      void p.then(
        () => pending.delete(p),
        () => pending.delete(p),
      );
      return p;
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
      return !closed && !unknown && s
        ? s.invoke(input)
        : {
            kind: 'not_started',
            code: 'catalog_unavailable',
            invocationId: input.invocationId,
            detail: 'no active catalog',
          };
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
