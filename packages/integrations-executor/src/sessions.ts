/** One isolated SDK host per consented discovery; credentials never leave memory. */
import { ServicePluginDiscoveryRefusedError } from '@runnets/application';
import type {
  ServicePluginCatalog,
  ServicePluginTarget,
  ServicePluginSessions,
} from '@runnets/application';
import type { ExecutorTransportBackend } from './backend.js';
import type { ExecutorHost } from './host-types.js';
import type { ProvisioningOptions } from './provision-types.js';
import { createProvisioning } from './provision.js';
import { runDiscovery } from './discovery.js';
import { runInvocation } from './invoke.js';

interface Session {
  readonly host: ExecutorHost;
  readonly target: ServicePluginTarget;
  readonly reference: string;
  readonly credential: string;
}

const key = (target: ServicePluginTarget): string =>
  JSON.stringify([
    target.owner,
    target.integrationId,
    target.connectionId,
    target.authority?.generation,
    target.authority?.endpoint,
    target.authority?.pluginVersion,
    target.authority?.adapterVersion,
    target.authority?.credentialReference,
  ]);

export function createSessionBackend(
  options: ProvisioningOptions,
  createHost: () => Promise<ExecutorHost>,
): { backend: ExecutorTransportBackend; sessions: ServicePluginSessions } {
  const hosts = new Set<ExecutorHost>();
  const active = new Map<string, Session>();
  const receipts = new WeakMap<ServicePluginCatalog, Session>();
  let closed = false;
  const current = (session: Session | undefined) =>
    !closed &&
    session !== undefined &&
    options.resolveCredential(session.reference) === session.credential;
  const continuous = (session: Session | undefined) => {
    if (!current(session) || session === undefined) return false;
    const prior = active.get(key(session.target));
    return (
      prior === undefined ||
      (prior.reference === session.reference && prior.credential === session.credential)
    );
  };
  const sessions: ServicePluginSessions = {
    ready: (target) => current(active.get(key(target))),
    current: (catalog) => continuous(receipts.get(catalog)),
    publish(catalog, target) {
      const session = receipts.get(catalog);
      if (!continuous(session) || session === undefined) return false;
      const generation = session.target.authority?.generation;
      if (
        generation !== undefined &&
        target.authority?.generation !== generation &&
        target.authority?.generation !== generation + 1
      )
        return false;
      const original = {
        ...target,
        ...(target.authority === undefined
          ? {}
          : {
              authority: {
                ...target.authority,
                generation: generation ?? target.authority.generation,
              },
            }),
      };
      if (key(original) !== key(session.target)) return false;
      active.set(key(target), session);
      return true;
    },
  };
  const backend: ExecutorTransportBackend = {
    async discover(target, discoveryOptions) {
      // Snapshot before any await; provisioning receives this immutable configuration.
      const snapshot: ServicePluginTarget = Object.freeze({
        ...target,
        ...(target.authority === undefined
          ? {}
          : {
              authority: Object.freeze({ ...target.authority }),
            }),
      });
      const initialCredential =
        snapshot.authority === undefined
          ? undefined
          : options.resolveCredential(snapshot.authority.credentialReference);
      const descriptor = await options.provision(snapshot);
      if (descriptor === null)
        throw new ServicePluginDiscoveryRefusedError(
          'connection_unknown',
          'connection changed; request fresh discovery consent',
        );
      const reference = descriptor.connection.credentialReference;
      if (snapshot.authority !== undefined && reference !== snapshot.authority.credentialReference)
        throw new ServicePluginDiscoveryRefusedError(
          'connection_unknown',
          'credential reference changed',
        );
      const credential =
        snapshot.authority === undefined ? options.resolveCredential(reference) : initialCredential;
      if (typeof credential !== 'string' || credential.trim() === '' || credential.length > 4096)
        throw new ServicePluginDiscoveryRefusedError('transport_failure', 'credential unavailable');
      const prior = active.get(key(snapshot));
      if (
        options.resolveCredential(reference) !== credential ||
        (prior !== undefined && (prior.reference !== reference || prior.credential !== credential))
      )
        throw new ServicePluginDiscoveryRefusedError(
          'connection_unknown',
          'credential changed; request fresh discovery consent',
        );
      const host = await createHost();
      hosts.add(host);
      try {
        if (closed) throw new Error('transport closed');
        // This provider and SDK database are owned by this snapshot exclusively.
        await createProvisioning(host, {
          allowedOrigins: options.allowedOrigins,
          provision: () => descriptor,
          resolveCredential: (name) => (name === reference ? credential : null),
        }).ensure(snapshot);
        const catalog = await runDiscovery(host, snapshot, discoveryOptions);
        const session: Session = { host, target: snapshot, reference, credential };
        receipts.set(catalog, session);
        // Adapter-only consumers without Ocean authority retain the plain transport contract.
        if (snapshot.authority === undefined) active.set(key(snapshot), session);
        return catalog;
      } catch (error) {
        hosts.delete(host);
        await host.close();
        throw error;
      }
    },
    invoke(target, invocation, invokeOptions) {
      // Select once before awaiting anything: an admitted call never changes account/route.
      const session = active.get(key(target));
      if (!current(session) || session === undefined)
        return Promise.resolve({
          kind: 'not_started',
          invocationId: invocation.invocationId,
          code: session === undefined ? 'connection_unknown' : 'catalog_unavailable',
          detail: 'Discovery required: consent, discover and grant this connection in the runtime.',
        });
      return runInvocation(session.host, session.target, invocation, invokeOptions);
    },
    async close() {
      closed = true;
      active.clear();
      await Promise.all([...hosts].map((host) => host.close()));
      hosts.clear();
    },
  };
  return { backend, sessions };
}
