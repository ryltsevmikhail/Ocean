import { createHash } from 'node:crypto';
import {
  MANAGED_LIFETIME_RUN,
  MANAGED_LIFETIME_TOOL,
  managedEnrollment,
  managedLifetimeFingerprint,
  validManagedLifetime,
  type ServiceConnection,
  type ToolEffectAdmission,
} from '@runnets/domain';
import type {
  ServiceAuthorityStorePort,
  ServiceCallAdmissionOptions,
  ToolEffectRecord,
} from '@runnets/application';
import {
  prepareManagedResourceEvidence,
  verifyManagedStdioEnrollments,
  type ManagedStdioHandle,
} from '@runnets/tools-node';
import type {
  McpManagedLifetime,
  McpManagedSession,
  McpServiceTransportOptions,
} from '@runnets/integrations-mcp';
/** This capability exists only in the owning runtime, never in the service protocol. */
function prepareRuntimeManagedLifetime(
  store: ServiceAuthorityStorePort,
  c: ServiceConnection,
  handle: ManagedStdioHandle,
  signal: AbortSignal,
  current: () => boolean,
): McpManagedLifetime {
  if (
    c.configuration.kind !== 'stdio' ||
    !c.configuration.workspaceRoot ||
    c.configuration.workspaceRoot !== handle.footprint.root ||
    !current()
  )
    throw Error('managed enrollment unavailable');
  const enrollment = managedEnrollment(c);
  const admission: ToolEffectAdmission = {
    scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: c.id }] },
    effectKind: 'mutation',
    grantReference: null,
    binding: {
      connectionId: c.id,
      managedWorkspace: { ...handle.footprint },
      managedEnrollment: enrollment,
      managedLifetime: {
        version: 1,
        nonce: handle.nonce,
        unit: handle.unit,
        cgroup: handle.cgroup,
        enrollment,
      },
    },
  };
  const identity = {
    id: handle.nonce,
    tool: MANAGED_LIFETIME_TOOL,
    taskRunId: MANAGED_LIFETIME_RUN,
    attemptId: handle.nonce,
    admission,
  };
  const record: ToolEffectRecord = {
    ...identity,
    outcome: 'started',
    fingerprint: createHash('sha256').update(managedLifetimeFingerprint(identity)).digest('hex'),
  };
  const evidence = prepareManagedResourceEvidence(
    admission,
    store.atomic((tx) => tx.pending()),
    signal,
    undefined,
    handle.deadlineAt,
  );
  let claimed = false,
    finished = false;
  return {
    record,
    begin() {
      try {
        if (claimed || finished || !current() || !handle.inspect() || !evidence.inspect())
          return false;
        claimed = store.atomic((tx) => tx.claimLifetime(identity, evidence.facts));
        return claimed;
      } finally {
        evidence.close();
      }
    },
    finish(status, lost) {
      evidence.close();
      if (!claimed || finished) return;
      store.atomic((tx) =>
        tx.settleLifetime(
          record,
          lost || status === 'unknown'
            ? 'uncertain'
            : status === 'never_started'
              ? 'not_started'
              : 'completed',
        ),
      );
      finished = true;
    },
  };
}

/** Cap-only extraction of the normal host's managed transport/admission composition. */
export function runtimeManagedAuthority(
  store: ServiceAuthorityStorePort,
  profile: string,
  signal: AbortSignal,
  current: (c: ServiceConnection) => boolean,
  getManaged: (c: ServiceConnection) => McpManagedSession | null,
): {
  transport: Pick<McpServiceTransportOptions, 'prepareManagedLifetime'>;
  admission: Pick<ServiceCallAdmissionOptions, 'classify' | 'prepareResources'>;
} {
  return {
    transport: {
      prepareManagedLifetime: async (c, handle) => {
        const preparation = AbortSignal.any([signal, handle.preparationSignal]);
        const snapshot = store.atomic((tx) => ({
          connections: tx.listConnections(),
          pending: tx.pending(),
        }));
        const units = snapshot.pending
          .filter((r) => r.outcome === 'started' && validManagedLifetime(r))
          .map((r) =>
            String(
              (
                (r.admission!.binding as Record<string, unknown>)['managedLifetime'] as Record<
                  string,
                  unknown
                >
              )['unit'],
            ),
          );
        await verifyManagedStdioEnrollments(
          profile,
          snapshot.connections.filter((r) => r.configuration.kind === 'stdio').map((r) => r.id),
          units,
          preparation,
        );
        return prepareRuntimeManagedLifetime(store, c, handle, preparation, () => current(c));
      },
    },
    admission: {
      classify: (c) => {
        const managed = getManaged(c);
        return managed
          ? {
              scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: c.id }] },
              effectKind: 'mutation',
              managedWorkspace: managed.handle.footprint,
              managedEnrollment: (
                managed.lifetime.record.admission!.binding as Record<string, string>
              )['managedEnrollment']!,
              managedSession: managed.lifetime.record.fingerprint,
            }
          : { scope: { kind: 'legacy-global-unknown' }, effectKind: 'mutation' };
      },
      prepareResources: (admitted, signal, deadline) => {
        const binding = admitted.binding;
        if (
          !binding ||
          typeof binding !== 'object' ||
          Array.isArray(binding) ||
          !('managedSession' in binding)
        )
          return Promise.resolve({ facts: { pairs: [] }, inspect: () => true, close: () => {} });
        if (typeof binding['connectionId'] !== 'string') throw Error('managed connection missing');
        const id = binding['connectionId'];
        const c = store.atomic((tx) => tx.connection(id));
        const managed = c && getManaged(c);
        if (!managed || managed.lifetime.record.fingerprint !== binding['managedSession'])
          throw Error('managed generation unavailable');
        return Promise.resolve(
          prepareManagedResourceEvidence(
            admitted,
            store.atomic((tx) => tx.pending()),
            signal,
            managed.lifetime.record,
            deadline,
          ),
        );
      },
    },
  };
}
