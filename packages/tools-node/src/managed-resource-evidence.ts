import { managedWorkspaceOf, type ToolEffectAdmission } from '@runnets/domain';
import type {
  ServiceResourceEvidence,
  ServiceResourceFacts,
  ToolEffectRecord,
} from '@runnets/application';
import {
  openManagedWorkspace,
  sameManagedWorkspace,
  type ManagedWorkspaceWitness,
} from './managed-workspace.js';
/** No I/O occurs inside journal transactions; all exemptions bind exact pending snapshots. */
export function prepareManagedResourceEvidence(
  incoming: ToolEffectAdmission,
  pending: readonly ToolEffectRecord[],
  signal: AbortSignal,
  own?: ToolEffectRecord,
  deadline = Date.now() + 15000,
): ServiceResourceEvidence {
  const opened = new Map<string, ManagedWorkspaceWitness>();
  const pairs: ServiceResourceFacts['pairs'][number][] = [];
  let components = 0;
  const open = (a: ToolEffectAdmission | undefined) => {
    const saved = managedWorkspaceOf(a);
    if (!saved) return null;
    let witness = opened.get(saved.root);
    if (!witness) {
      components += saved.root.split('/').length;
      if (opened.size >= 32 || components > 128) throw Error('managed comparison limit');
      witness = openManagedWorkspace(saved.root, signal, [], deadline);
      opened.set(saved.root, witness);
    }
    return sameManagedWorkspace(saved, witness.footprint) ? witness : null;
  };
  try {
    const current = open(incoming);
    if (!current) throw Error('managed workspace stale');
    for (const row of pending) {
      let prior: ManagedWorkspaceWitness | null;
      try {
        prior = open(row.admission);
      } catch {
        prior = null;
      }
      if (prior)
        pairs.push({
          row: structuredClone(row),
          pair: {
            existing: row.admission!,
            incoming,
            existingCoordinate: prior.coordinate,
            incomingCoordinate: current.coordinate,
          },
        });
    }
    return {
      facts: { pairs, ...(own ? { own: structuredClone(own) } : {}) },
      inspect: () =>
        !signal.aborted && [...opened.values()].every((v) => v.inspect()) && Date.now() < deadline,
      close: () => {
        for (const v of opened.values()) v.close();
      },
    };
  } catch (error) {
    for (const v of opened.values()) v.close();
    throw error;
  }
}
