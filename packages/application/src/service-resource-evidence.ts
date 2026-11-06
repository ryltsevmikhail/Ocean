import {
  canonicalJson,
  effectResourcesConflict,
  validManagedLifetime,
  managedWorkspaceOf,
  type ManagedWorkspacePair,
  type ToolEffectAdmission,
} from '@runnets/domain';
import type { ToolEffectRecord } from './tools.js';
/** Exact snapshot facts produced by a trusted held-descriptor adapter, outside SQLite. */
export interface ServiceResourceFacts {
  readonly pairs: readonly {
    readonly row: ToolEffectRecord;
    readonly pair: ManagedWorkspacePair;
  }[];
  readonly own?: ToolEffectRecord;
}
export interface ServiceResourceEvidence {
  readonly facts: ServiceResourceFacts;
  inspect(): boolean;
  close(): void;
}
export function serviceResourceConflicts(
  row: ToolEffectRecord,
  incoming: ToolEffectAdmission,
  facts?: ServiceResourceFacts,
): boolean {
  const own = facts?.own;
  if (
    own &&
    row.outcome === 'started' &&
    validManagedLifetime(row) &&
    canonicalJson(row) === canonicalJson(own) &&
    managedWorkspaceOf(incoming) &&
    incoming.binding &&
    typeof incoming.binding === 'object' &&
    !Array.isArray(incoming.binding) &&
    (incoming.binding as Record<string, unknown>)['managedSession'] === row.fingerprint &&
    (incoming.binding as Record<string, unknown>)['managedEnrollment'] ===
      (row.admission!.binding as Record<string, unknown>)['managedEnrollment'] &&
    canonicalJson(managedWorkspaceOf(row.admission)) === canonicalJson(managedWorkspaceOf(incoming))
  )
    return false;
  const pair = facts?.pairs.find((v) => canonicalJson(v.row) === canonicalJson(row))?.pair;
  return effectResourcesConflict(row.admission, incoming, pair);
}

export function serviceResourceFactsCurrent(
  pending: readonly ToolEffectRecord[],
  incoming: ToolEffectAdmission,
  facts?: ServiceResourceFacts,
): boolean {
  const binding = incoming.binding;
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    !('managedSession' in binding)
  )
    return true;
  return (
    !!facts?.own &&
    pending.some(
      (row) =>
        canonicalJson(row) === canonicalJson(facts.own) &&
        row.outcome === 'started' &&
        validManagedLifetime(row) &&
        !serviceResourceConflicts(row, incoming, { pairs: [], own: row }),
    )
  );
}
