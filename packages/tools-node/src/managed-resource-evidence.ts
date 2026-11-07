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
import { managedBudget } from './managed-workspace-anchor.js';
/** Bounded asynchronous evidence outside SQLite; no helper or scan in the final synchronous guard. */
export async function prepareManagedResourceEvidence(
  incoming: ToolEffectAdmission,
  pending: readonly ToolEffectRecord[],
  signal: AbortSignal,
  own?: ToolEffectRecord,
  deadline = Date.now() + 15000,
): Promise<ServiceResourceEvidence> {
  const opened = new Map<string, ManagedWorkspaceWitness>();
  const pairs: ServiceResourceFacts['pairs'][number][] = [];
  let components = 0;
  const open = async (a: ToolEffectAdmission | undefined) => {
    managedBudget(signal, deadline);
    const saved = managedWorkspaceOf(a);
    if (!saved) return null;
    let witness = opened.get(saved.root);
    if (!witness) {
      components += saved.root.split('/').length;
      if (opened.size >= 32 || components > 128) throw Error('managed comparison limit');
      witness = await openManagedWorkspace(saved.root, signal, [], deadline);
      opened.set(saved.root, witness);
    }
    return sameManagedWorkspace(saved, witness.footprint) ? witness : null;
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        [...opened.values()].map((v) => Promise.resolve().then(() => v.close())),
      );
      const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
      if (errors.length) throw new AggregateError(errors, 'Managed resource close failed');
    })());
  try {
    const current = await open(incoming);
    if (!current) throw Error('managed workspace stale');
    for (const row of pending) {
      managedBudget(signal, deadline);
      let prior: ManagedWorkspaceWitness | null;
      try {
        prior = await open(row.admission);
      } catch {
        managedBudget(signal, deadline);
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
    for (const witness of opened.values()) {
      managedBudget(signal, deadline);
      if (!(await witness.recheck())) throw Error('managed workspace stale');
    }
    managedBudget(signal, deadline);
    return {
      facts: { pairs, ...(own ? { own: structuredClone(own) } : {}) },
      inspect: () => {
        for (const witness of opened.values()) {
          if (signal.aborted || Date.now() >= deadline || !witness.inspect()) return false;
        }
        return !signal.aborted && Date.now() < deadline;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Managed preparation and close failed');
    }
    throw error;
  }
}
